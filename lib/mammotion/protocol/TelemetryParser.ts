import type { TelemetryState } from '../mqtt/MqttClient.js';

/**
 * Extract TelemetryState from a decoded LubaMsg plain object (camelCase fields).
 * Used by both MQTT and BLE paths — the same LubaMsg protobuf carries the same
 * report_info_data regardless of transport.
 *
 * Field path: LubaMsg.sys.toappReportData → {connect, dev, rtk, work}
 *
 * Packing note (confirmed against Mammotion-HA sensor.py):
 *   work.area:     low16 = area in m², high16 = progress %
 *   work.progress: low16 = total_time (min), high16 = left_time (min)
 *   elapsed_time  = total_time − left_time (derived, not a wire field)
 *   mowingSpeed   = work.manRunSpeed / 100 (m/s)
 */
export function extractTelemetry(msg: Record<string, unknown>): Partial<TelemetryState> | null {
  const sys = msg.sys as Record<string, unknown> | undefined;
  const report = sys?.toappReportData as Record<string, unknown> | undefined;
  if (!report) return null;

  const telemetry: Partial<TelemetryState> = {};

  const connect = report.connect as Record<string, number> | undefined;
  if (connect) {
    if (typeof connect.bleRssi === 'number') telemetry.bleRssi = connect.bleRssi;
    if (typeof connect.wifiRssi === 'number') telemetry.wifiRssi = connect.wifiRssi;
  }

  const dev = report.dev as Record<string, number> | undefined;
  if (dev) {
    if (typeof dev.sysStatus === 'number') telemetry.workMode = dev.sysStatus;
    if (typeof dev.chargeState === 'number') telemetry.chargeState = dev.chargeState;
    if (typeof dev.batteryVal === 'number') telemetry.batteryPercent = dev.batteryVal;
    // Diagnostic-only for now: rpt_dev_status.headlamp_status exists on the wire (same
    // sub-message as sysStatus/batteryVal above) but is never read by Mammotion-HA, so its
    // encoding (simple on/off vs. a bitmask distinguishing headlamp from side LED — our
    // own SetHeadlamp command uses a set_ids selector for that distinction) is unverified.
    // Logged via device.ts's telemetry-changed line so we can collect real values before
    // mapping this to mow_headlamp/mow_side_led. See docs/ROADMAP.md.
    if (typeof dev.headlampStatus === 'number') telemetry.headlampStatusRaw = dev.headlampStatus;
  }

  const rtk = report.rtk as Record<string, number> | undefined;
  if (rtk) {
    if (typeof rtk.gpsStars === 'number') telemetry.gpsStars = rtk.gpsStars;
    if (typeof rtk.posLevel === 'number') telemetry.posLevel = rtk.posLevel;
  }

  const work = report.work as Record<string, number> | undefined;
  if (work) {
    if (typeof work.area === 'number') {
      telemetry.area = work.area & 0xffff;
      telemetry.progress = (work.area >>> 16) & 0xffff;
    }
    if (typeof work.progress === 'number') {
      const totalTime = work.progress & 0xffff;
      const leftTime = (work.progress >>> 16) & 0xffff;
      telemetry.leftTime = leftTime;
      telemetry.elapsedTime = Math.max(0, totalTime - leftTime);
    }
    if (typeof work.manRunSpeed === 'number') telemetry.mowingSpeed = work.manRunSpeed / 100;
    // rpt_work.knife_height — a plain mm value, confirmed against Mammotion-HA's
    // sensor.py (report_data.work.knife_height, DISTANCE/MILLIMETERS), not packed like
    // area/progress above. Previously only ever set optimistically from our own SET
    // commands (never confirmed by the mower) — this closes that gap.
    if (typeof work.knifeHeight === 'number') telemetry.bladeHeight = work.knifeHeight;
  }

  const maintain = report.maintain as Record<string, unknown> | undefined;
  if (maintain) {
    if (typeof maintain.batCycles === 'number') telemetry.batteryCycles = maintain.batCycles;
    const bladeUsed = maintain.bladeUsedTime as Record<string, number> | undefined;
    if (bladeUsed && typeof bladeUsed.bladeUsedTime === 'number') {
      // bladeUsedTime is in SECONDS — confirmed against Mammotion-HA's sensor.py
      // (native_unit_of_measurement=UnitOfTime.SECONDS for this exact field). A prior
      // "in minutes" comment here was wrong and made measure_blade_used_time overstate
      // real usage by 60x (e.g. ~54h real use showing as ~3241h) — confirmed against a
      // real device's reported value, 2026-07-04.
      telemetry.bladeUsedTime = bladeUsed.bladeUsedTime;
    }
  }

  return telemetry;
}
