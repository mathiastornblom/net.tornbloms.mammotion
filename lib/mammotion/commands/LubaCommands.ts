import {
  encodeLubaMsg,
  encodeLubaMsgBase64,
  MsgCmdType,
  MsgDevice,
  MsgAttr,
  RptAct,
  RptInfoType,
} from '../protocol/Codec.js';

export type DeviceCommand = 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock';

/** Options accepted by the start-mowing flow card. */
export interface StartMowOptions {
  bladeHeight?: number;
  speed?: number;
  isEdge?: boolean;
}

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

/** Whether the device is a Luba Pro (NAV commands route to DEV_NAVIGATION). */
export function isLubaProDevice(deviceName: string): boolean {
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
): string {
  const rcver = isLubaProDevice(deviceName) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
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
): string {
  return buildTaskControlCommand('start', userAccount, deviceName, seq);
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
): string {
  const receiver = isLubaProDevice(deviceName) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevPlanjobSet: { subCmd: 2, planIndex },
    },
  });
}
