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
 * 27). It's a flat `repeated int64 update_buf_data`; the first element is a "buf_id" tag
 * distinguishing what the rest of the array means. Per pymammotion's `MowerDevice.buffer()`
 * (`data/model/device.py`), confirmed on a real mower capture 2026-07-09 (see
 * docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md's Captures log): id 1 is RTK base/dock position,
 * id 3 is the active task-zone hash + status, and id 2 — not yet observed on a real device —
 * is the mower's own fault-history list (code + timestamp pairs; NOT Spino-only as previously
 * assumed here, Spino has its own parallel decoder for the same id). Diagnostic-only: returns
 * the raw array unconditionally, whatever its first element is, so a real fault capture can
 * confirm id 2's contents once one actually fires.
 */
export function extractUpdateBuf(msg: Record<string, unknown>): number[] | null {
  const sys = msg.sys as Record<string, unknown> | undefined;
  const buf = sys?.systemUpdateBuf as Record<string, unknown> | undefined;
  const data = buf?.updateBufData;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(Number);
}

/**
 * Extracts MctlSys.bidireCommCmd (SysCommCmd, the general-purpose read/write parameter
 * channel — pymammotion's `allpowerfull_rw`/`read_write_device`) when it carries id=3, the
 * rain-detection feature toggle. The device echoes its current state back on this same
 * channel — both as a direct reply to our own read (rw=0) or write (rw=1) command, and
 * (per pymammotion's state_reducer) whenever the setting changes from another source, e.g.
 * the official Mammotion app — so this keeps mow_rain_protection in sync regardless of
 * which app last changed it. Other rw_ids on this channel (turning_mode, traversal_mode,
 * etc. — see pymammotion's state_reducer.py) aren't surfaced as capabilities yet.
 */
export function extractRainProtection(msg: Record<string, unknown>): boolean | null {
  const sys = msg.sys as Record<string, unknown> | undefined;
  const comm = sys?.bidireCommCmd as Record<string, unknown> | undefined;
  if (!comm || comm.id !== 3 || typeof comm.context !== 'number') return null;
  return comm.context !== 0;
}
