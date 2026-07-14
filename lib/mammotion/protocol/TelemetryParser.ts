import type { TelemetryState } from '../mqtt/MqttClient.js';

/**
 * Decodes rpt_dev_status.sensor_status's bumper sub-field (bits 0-2) into Homey's
 * mow_bumper_state enum. Bit layout confirmed directly against pymammotion's
 * data/model/report_info.py (`bumper_state` property: `raw = sensor_status & 0x7`,
 * clamped to its SensorCheckState enum — OK=0, WARNING=1, ERROR=2, with any of the
 * remaining 3-7 raw values also clamped to ERROR), itself sourced from the official
 * Mammotion Android app per that file's own comments — not inferred from our own captures.
 */
export function decodeBumperState(sensorStatus: number): 'ok' | 'warning' | 'error' {
  const raw = sensorStatus & 0x7;
  if (raw >= 2) return 'error';
  if (raw === 1) return 'warning';
  return 'ok';
}

/**
 * Decodes rpt_dev_status.sensor_status's blade sub-field (bits 9-11) into a boolean —
 * true whenever the cutting blade motor is spinning. Same source/confirmation as
 * decodeBumperState above: `raw = (sensor_status >> 9) & 0x7`, `ON if raw else OFF`.
 * (A "+512" bit change previously mistaken for a possible wheel-lift/fault signal in a
 * real diagnostic capture was this field turning on as mowing resumed — not a fault.)
 */
export function decodeBladeActive(sensorStatus: number): boolean {
  return ((sensorStatus >>> 9) & 0x7) !== 0;
}

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
    if (typeof dev.sensorStatus === 'number') {
      telemetry.sensorStatusRaw = dev.sensorStatus;
      // bumper_state/blade_state are confirmed decodes (see decodeBumperState/
      // decodeBladeActive above) — mapped to real capabilities. The raw value is still kept
      // above too: sensor_status also carries four ultrasonic-sensor sub-fields (bits
      // 12-23) this app doesn't decode yet, and self_check_status (below) has no upstream
      // interpretation at all — both remain open questions in the wheel-lift/emergency-stop
      // investigation (docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md).
      telemetry.bumperState = decodeBumperState(dev.sensorStatus);
      telemetry.bladeActive = decodeBladeActive(dev.sensorStatus);
    }
    // Diagnostic-only: rpt_dev_status.self_check_status has no upstream interpretation
    // anywhere in Mammotion-HA/pymammotion — logged raw so a real forced-fault diagnostic
    // report can still identify a meaning empirically. See
    // docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md.
    if (typeof dev.selfCheckStatus === 'number') telemetry.selfCheckStatusRaw = dev.selfCheckStatus;
    // Diagnostic-only: rpt_dev_status.sys_time_stamp is never read by Mammotion-HA either,
    // and its epoch/units are unconfirmed (unix seconds vs. ms vs. device-uptime counter).
    // Logged (alongside device.ts's own Date.now() at receipt) to test a real hypothesis:
    // two real diagnostic reports on the same device now show mower_status rapidly
    // flip-flopping between 'mowing'/'charging' within seconds during a sustained Aliyun
    // rate-limiting window that later dropped the connection entirely — consistent with
    // stale/out-of-order buffered reports being applied as if live, not a real physical
    // oscillation. If sysTimeStampRaw turns out to be wall-clock and lags noticeably behind
    // receipt time during exactly these windows, that confirms it and gives us a field to
    // reject stale reports on.
    if (typeof dev.sysTimeStamp === 'number') telemetry.sysTimeStampRaw = dev.sysTimeStamp;
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
    // mileage (metres) and workTime (seconds) are lifetime totals — confirmed against
    // pymammotion's report_info.py (`mileage: int = 0  # lifetime distance travelled,
    // metres`) and Mammotion-HA's sensor.py (maintenance_distance/maintenance_work_time,
    // native units METERS/SECONDS respectively). Cross-checked against a real device's
    // reported values (2026-07-14): mileage=26546m (~26.5km) and workTime=96415s (~26.8h),
    // both plausible against that same device's already-confirmed bladeUsedTime (~24.5h) —
    // work time being slightly higher than blade-spinning time makes sense (positioning/
    // docking time isn't spent cutting).
    if (typeof maintain.mileage === 'number') telemetry.mileage = maintain.mileage;
    if (typeof maintain.workTime === 'number') telemetry.workTime = maintain.workTime;
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
