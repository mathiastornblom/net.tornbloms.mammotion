import {
  encodeLubaMsg,
  encodeLubaMsgBase64,
  MsgCmdType,
  MsgDevice,
  MsgAttr,
  RptAct,
  RptInfoType,
} from '../protocol/Codec.js';
import { LEGACY_LUBA1_PRODUCT_KEYS, NON_MOWER_PRODUCT_KEYS } from '../constants.js';

// lamp_manual_ctrl_sta enum values (luba_mul.proto)
const LAMP_MANUAL_CTRL = { manual_power_off: 0, manual_power_on: 1 } as const;

/** Task-control commands accepted by buildTaskControlCommand. */
export type DeviceCommand = 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock';

/** Options accepted by the start-mowing flow card. */
export interface StartMowOptions {
  bladeHeight?: number;
  speed?: number;
  isEdge?: boolean;
}

/** Blade/cutter speed mode (CutterWorkMode enum in mctrl_driver.proto). */
export type CutterMode = 0 | 1 | 2; // 0=standard, 1=economic (slow), 2=performance (fast)

/** Maps the Homey-facing speed label to the wire-level CutterMode value. */
export const CUTTER_MODE_MAP: Record<'economic' | 'standard' | 'performance', CutterMode> = {
  economic: 1,
  standard: 0,
  performance: 2,
};

/** NavTaskCtrl.action values (mctrl_nav.proto / navigation.py). */
const TASK_ACTION: Record<DeviceCommand, number> = {
  start: 1,
  pause: 2,
  resume: 3,
  stop: 4, // end/cancel job
  cancelJob: 4,
  dock: 5, // return to charge
  cancelDock: 12,
};

/** Report-channel subscription list used by pymammotion's get_report_cfg. */
const REPORT_SUB = [
  RptInfoType.RIT_CONNECT,
  RptInfoType.RIT_RTK,
  RptInfoType.RIT_DEV_LOCAL,
  RptInfoType.RIT_WORK,
  RptInfoType.RIT_DEV_STA,
  RptInfoType.RIT_VISION_POINT,
  RptInfoType.RIT_VIO,
  RptInfoType.RIT_VISION_STATISTIC,
  RptInfoType.RIT_BASESTATION_INFO,
  RptInfoType.RIT_FW_INFO,
];

/**
 * Whether NAV commands should route to DEV_NAVIGATION (17) instead of DEV_MAINCTL (1).
 * Mirrors pymammotion's DeviceType.is_luba_pro(): true for every mower classification
 * EXCEPT the original Luba 1 (RTK/pool aren't paired through this driver).
 *
 * productKey is authoritative and always available (even for shared-not-owned devices,
 * unlike the numeric deviceType field which the owned-devices-only API omits — see
 * MammotionAuth.fetchDevices vs fetchDeviceRecords). The device-name substring check is
 * kept only as a last-resort fallback for a productKey we don't yet recognize.
 */
export function isLubaProDevice(deviceName: string, productKey?: string): boolean {
  if (productKey) {
    if (LEGACY_LUBA1_PRODUCT_KEYS.includes(productKey)) return false;
    if (NON_MOWER_PRODUCT_KEYS.includes(productKey)) return false; // shouldn't occur via this driver
    // Any other known-shape Mammotion/Aliyun product key (a1xxxxxxxxx, or a bare
    // alphanumeric like uY54W5rM8YH) is treated as "Luba 2 or higher".
    return true;
  }
  const lower = deviceName.toLowerCase();
  return lower.includes('luba pro') || lower.includes('lubapro');
}

/** Shared envelope fields for a request LubaMsg. */
function envelope(msgtype: number, rcver: number, userAccount: string, seq: { value: number }): Record<string, unknown> {
  seq.value = (seq.value + 1) & 0xff;
  return {
    msgtype,
    sender: MsgDevice.DEV_MOBILEAPP,
    rcver,
    msgattr: MsgAttr.REQ,
    seqs: seq.value,
    version: 1,
    subtype: parseInt(userAccount, 10) || 0,
    timestamp: Date.now(),
  };
}

/**
 * Build a report-config command (telemetry subscription). The mower replies with
 * device_protobuf_msg_event frames carrying report_info_data. count=0 streams
 * continuously until stopped; the caller re-arms periodically.
 */
export function buildRequestIotSyncCommand(
  userAccount: string,
  stop: boolean,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_SYS, MsgDevice.DEV_MAINCTL, userAccount, seq),
    sys: {
      todevReportCfg: {
        act: stop ? RptAct.RPT_STOP : RptAct.RPT_START,
        timeout: 10_000,
        period: 1_000,
        noChangePeriod: 4_000,
        // One-shot per request — the device replies with a single report, which the
        // caller re-arms every 5s (matching Mammotion-HA). count=0 (continuous) floods
        // the constrained Homey hub with ~1 Hz decodes + capability writes.
        count: 1,
        sub: REPORT_SUB,
      },
    },
  });
}

/** Build a start/pause/resume/stop/dock task-control command. */
export function buildTaskControlCommand(
  command: DeviceCommand,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const rcver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, rcver, userAccount, seq),
    nav: {
      todevTaskctrl: { type: 1, action: TASK_ACTION[command], result: 0 },
    },
  });
}

/**
 * Build a start-mowing command. Starts/resumes the device's configured job via
 * todev_taskctrl (action=1). Blade height/speed are applied separately by the
 * caller (set_blade_height); full per-job route planning is deferred to the maps
 * phase, so route options other than those are not sent.
 */
export function buildStartMowCommand(
  _options: StartMowOptions,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  return buildTaskControlCommand('start', userAccount, deviceName, seq, productKey);
}

/**
 * Build a rain-protection command (MctlSys.bidireCommCmd, id=3 — the general-purpose
 * read/write parameter channel, `allpowerfull_rw`/`read_write_device` in pymammotion).
 * Confirmed against pymammotion's `async_set_rain_detection` (id=3, rw=1, context=on/off) and
 * the official app's own "Rain Protection" toggle (a standalone Safety Features setting,
 * "Automatically stop task when rain is detected" — independent of any job/route config).
 * The previous implementation sent `MctlSys.jobPlan.rainTactics`, a *job-start* parameter
 * that pymammotion only ever bundles inside a full route-generation message alongside
 * job_id/job_mode/knife_height — never sent bare — so it was very likely a silent no-op, the
 * same failure mode as the old headlamp command. This device also echoes its current
 * rain-detection state back on the same `bidireCommCmd` id=3 channel (rw=0), which
 * ErrorCodeParser.ts's extractRainProtection reads to keep mow_rain_protection in sync
 * with changes made in the official app.
 */
export function buildSetRainProtectionCommand(
  enabled: boolean,
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_SYS, MsgDevice.DEV_MAINCTL, userAccount, seq),
    sys: {
      bidireCommCmd: { id: 3, context: enabled ? 1 : 0, rw: 1 },
    },
  });
}

/** Build a read request for the rain-protection state (MctlSys.bidireCommCmd, id=3, rw=0) —
 *  see buildSetRainProtectionCommand's doc comment for the full protocol context. */
export function buildReadRainProtectionCommand(
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_SYS, MsgDevice.DEV_MAINCTL, userAccount, seq),
    sys: {
      bidireCommCmd: { id: 3, context: 0, rw: 0 },
    },
  });
}

/**
 * Build a set-headlamp command (SocMul.set_lamp / SetHeadlamp in luba_mul.proto) — the
 * *manual* on/off toggle (as opposed to the separate night-time auto-lighting mode, which
 * this app doesn't expose as a capability). Confirmed against pymammotion's
 * `set_car_manual_light` (mammotion/commands/messages/media.py): `set_ids` is NOT a fixed
 * per-lamp index — it's 1125 for a manual-ON request and 1127 for a manual-OFF request,
 * alongside `lamp_power_ctrl=2` (fixed) and `lamp_manual_ctrl` carrying the actual on/off
 * enum. The previous implementation used `set_ids=0`/`1` (an invented main/side-lamp
 * index) plus an unrelated `lamp_ctrl` field (that belongs to the separate auto
 * night-light command, `set_car_light`, `set_ids=1121`) — Aliyun's gateway accepted it as
 * valid protobuf (`code:0` success) but the mower's firmware had no reason to recognize
 * those `set_ids` values, matching a real diagnostic report (2026-07-13, Luba 3): the
 * headlamp toggle showed success in Homey but never lit the physical lamp, while working
 * fine from the official Mammotion app. Side LED uses a completely different message bus
 * (MctlSys.todev_time_ctrl_light) — see buildSetSideLedCommand, not this function.
 */
export function buildSetHeadlampCommand(
  on: boolean,
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.MUL, MsgDevice.SOC_MODULE_MULTIMEDIA, userAccount, seq),
    mul: {
      setLamp: {
        setIds: on ? 1125 : 1127,
        lampPowerCtrl: 2,
        lampManualCtrl: on ? LAMP_MANUAL_CTRL.manual_power_on : LAMP_MANUAL_CTRL.manual_power_off,
      },
    },
  });
}

/**
 * Build a side-LED command (MctlSys.todev_time_ctrl_light / TimeCtrlLight in
 * mctrl_sys.proto) — a completely different message bus from the headlamp (SYS, not MUL).
 * Confirmed against pymammotion's `read_and_set_sidelight` (mammotion/commands/messages/
 * system.py): `operate=0` means write/set (as opposed to 1, read/query); `enable` is
 * INVERTED — 0 means the light is on, 1 means off. The previous implementation reused
 * buildSetHeadlampCommand with `set_ids=1`, which was wrong on two levels: wrong message
 * bus entirely, and `set_ids=1` isn't a real value in either the headlamp or side-LED
 * protocol (see buildSetHeadlampCommand's doc comment for the real set_ids values).
 */
export function buildSetSideLedCommand(
  on: boolean,
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_SYS, MsgDevice.DEV_MAINCTL, userAccount, seq),
    sys: {
      todevTimeCtrlLight: {
        operate: 0,
        enable: on ? 0 : 1,
        action: 0,
        startHour: 0,
        startMin: 0,
        endHour: 0,
        endMin: 0,
      },
    },
  });
}

/** Build a set-blade-speed command (MctlDriver.cutter_mode_ctrl_by_hand). */
export function buildSetBladeSpeedCommand(
  mode: CutterMode,
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_DRIVER, MsgDevice.DEV_MAINCTL, userAccount, seq),
    driver: {
      cutterModeCtrlByHand: { CutterMode: mode },
    },
  });
}

/** Build a set-blade-height command (MctlDriver.todev_knife_height_set). */
export function buildSetBladeHeightCommand(
  bladeHeightMm: number,
  userAccount: string,
  seq: { value: number },
): string {
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.EMBED_DRIVER, MsgDevice.DEV_MAINCTL, userAccount, seq),
    driver: {
      todevKnifeHeightSet: { knifeHeight: Math.trunc(bladeHeightMm) },
    },
  });
}

/**
 * Build the one-shot BLE connect/disconnect sync (DevNet.todev_ble_sync), sent right after
 * subscribing to notifications. Returns raw bytes (not base64) — BLE writes go directly over
 * GATT, unlike the MQTT path which posts base64 JSON to the cloud invoke endpoint.
 */
export function buildBleSyncCommand(syncType: number, seq: { value: number }): Buffer {
  return encodeLubaMsg({
    ...envelope(MsgCmdType.ESP, MsgDevice.DEV_COMM_ESP, '0', seq),
    net: { todevBleSync: syncType },
  });
}

/**
 * Build a READ-ONLY request for a stored mowing schedule (MctlNav.todev_planjob_set,
 * sub_cmd=2). The device replies by echoing the same field with the stored plan's data
 * filled in — see TelemetryParser.extractSchedule for response parsing.
 *
 * Deliberately does not expose create/edit/delete: the device's `reserved` byte encoding
 * (enable flag + other settings) is not fully understood even by the pymammotion reference
 * project, so writing a plan risks silently wrong behaviour. Read-only until verified.
 */
export function buildReadScheduleCommand(
  userAccount: string,
  deviceName: string,
  planIndex: number,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevPlanjobSet: { subCmd: 2, planIndex },
    },
  });
}
