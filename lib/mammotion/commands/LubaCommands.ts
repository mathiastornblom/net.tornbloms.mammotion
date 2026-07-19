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
  /** Zone hashes (fixed64, as strings — see AreaNameParser.ts) to mow. Omitted/empty means
   *  "mow every known zone", matching the reference app's own `async_plan_route` default. */
  areas?: string[];
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

/**
 * Build a request to run a stored mowing task ("schedule") right now, identified by its
 * `planId` (MctlNav.plan_task_execute, sub_cmd=1 — pymammotion's `single_schedule(plan_id)`,
 * the same command Home Assistant's per-schedule buttons call). The device looks up the
 * plan it already has stored and applies ALL of that plan's own settings itself — zones,
 * blade height, speed, route model/spacing, and cutting angle — none of which we decode,
 * re-derive, or re-send. This is a completely different message from buildReadScheduleCommand
 * (NavPlanJobSet, read/create/edit/delete) and from buildGenerateRouteCommand (which builds
 * our own ad-hoc route and cannot express a cutting angle at all — see
 * docs/SCHEDULE_START_PLAN.md). Never touches sub_cmd 1/3/4 on NavPlanJobSet itself, so this
 * carries none of the risk docs/SCHEDULING_PLAN.md flagged for full schedule write support.
 */
export function buildStartScheduleCommand(
  userAccount: string,
  deviceName: string,
  planId: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      planTaskExecute: { subCmd: 1, id: planId },
    },
  });
}

/**
 * Build a request for the device's full zone hash/name list (MctlNav.toapp_map_name_msg,
 * rw=0, hash=0 — a read-all request on the same channel `set_area_name` uses to write one).
 * Confirmed against pymammotion's `get_area_name_list`: `device_id` is the iotId, not the
 * deviceName. The device replies with `toapp_all_hash_name` — see AreaNameParser.ts.
 */
export function buildGetAreaNameListCommand(
  userAccount: string,
  deviceName: string,
  iotId: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      toappMapNameMsg: { rw: 0, hash: '0', result: 0, deviceId: iotId },
    },
  });
}

/**
 * Build a request for the device's raw root boundary/obstacle/path hash manifest
 * (MctlNav.todev_gethash, sub_cmd=0 — pymammotion's `get_all_boundary_hash_list(sub_cmd=0)`).
 * Unlike buildGetAreaNameListCommand, this is unfiltered by naming: it returns EVERY hash
 * the device holds (areas, obstacles, paths, no-go zones, ...), classified later per-hash
 * via buildSynchronizeHashDataCommand. Reply = toapp_gethash_ack, multi-frame and ack-driven
 * — see BoundaryHashParser.extractRootHashList and buildGetHashResponseCommand.
 */
export function buildGetBoundaryHashListCommand(
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevGethash: { pver: 1, subCmd: 0 },
    },
  });
}

/**
 * Build the per-frame ack for a root hash-list response (MctlNav.todev_gethash, sub_cmd=2)
 * — tells the device "got this frame, send the next one". Confirmed against pymammotion's
 * `get_hash_response`: this must NEVER be sent proactively, only in direct response to a
 * received toapp_gethash_ack frame — sending it early desyncs the ack-driven loop.
 */
export function buildGetHashResponseCommand(
  totalFrame: number,
  currentFrame: number,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevGethash: { pver: 1, subCmd: 2, currentFrame, totalFrame },
    },
  });
}

/**
 * Build a per-hash type-classification probe (MctlNav.todev_get_commondata, action=8,
 * sub_cmd=1 — pymammotion's `synchronize_hash_data`). The device replies with
 * toapp_get_commondata_ack, whose `.type` (PathType; 0=AREA) is the only thing this app
 * reads — see BoundaryHashParser.extractCommDataAck. `hash` is a decimal string (int64 on
 * the wire) and must never be coerced to a JS number. Must not be re-sent for a hash
 * already mid-stream, or the device restarts that hash's frames from 1.
 */
export function buildSynchronizeHashDataCommand(
  hash: string,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevGetCommondata: { pver: 1, action: 8, hash, subCmd: 1 },
    },
  });
}

/** A single per-hash classification ack frame, as needed to build its drain/ack echo —
 *  see buildRegionalDataAckCommand. Matches BoundaryHashParser.CommDataAckFrame's shape. */
export interface CommDataAckEcho {
  action: number;
  type: number;
  hash: string;
  totalFrame: number;
  currentFrame: number;
}

/**
 * Build the per-frame drain/ack for a classification response (MctlNav.todev_get_commondata,
 * sub_cmd=2 — pymammotion's `get_regional_data`), echoing action/type/hash/totalFrame/
 * currentFrame back from the received frame. Tells the device "got this frame, send the
 * next" so its stream for that hash keeps flowing until fully drained — abandoning a hash
 * mid-stream risks the device retransmitting it with an incrementing dataHash, adding noise
 * to a small-MTU BLE link. Only the `.type` this drains past has already been read by the
 * caller (requestBoundaryZoneDiscovery) by the time this is used; the polygon data itself
 * (dataCouple/x-y points) is discarded, matching this feature's "classification, not
 * mapping" scope.
 */
export function buildRegionalDataAckCommand(
  ack: CommDataAckEcho,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      todevGetCommondata: {
        pver: 1,
        action: ack.action,
        type: ack.type,
        hash: ack.hash,
        totalFrame: ack.totalFrame,
        currentFrame: ack.currentFrame,
        subCmd: 2,
      },
    },
  });
}

/**
 * Replicates pymammotion's `create_path_order` (data/model/device_config.py) for a Luba
 * 2/3-class mower (`is_luba_pro`, non-Yuka, non-Luba1 — the only class this driver targets;
 * Yuka/Luba1 support is deferred, see docs/ROADMAP.md). An 8-byte buffer, encoded as a
 * latin1/ASCII-safe string (every byte is in the 0-10 range) since NavReqCoverPath.reserved
 * is a proto `string` field, matching the Python source's own `bArr.decode()`.
 *
 * Byte layout (OperationSettings defaults: border_mode=0, obstacle_laps=1, start_progress=0,
 * is_dump=true, collect_grass_frequency=10): [border_mode, obstacle_laps, 0, start_progress,
 * 0, 8 (is_luba_pro), collect_grass_frequency, 0] = [0,1,0,0,0,8,10,0]. This encoding is
 * load-bearing — a wrong `reserved` risks the device computing an empty or wrong route.
 */
function createPathOrder(): string {
  return String.fromCharCode(0, 1, 0, 0, 0, 8, 10, 0);
}

/**
 * Build a "generate route" / plan-route command (MctlNav.bidire_reqconver_path,
 * NavReqCoverPath, sub_cmd=0 — "generate"). This is the step the reference app always runs
 * before starting a fresh job (`async_plan_route` → `generate_route_information`), which our
 * "start" command never sent — see docs/ZONE_SELECTION_PLAN.md for the real diagnostic
 * report this fixes (mower resuming an already-fully-mowed cached job and returning within
 * seconds). `areas` defaults to every known zone hash when empty, matching
 * `async_plan_route`'s own "mow everything" default — resolving that default is the caller's
 * job (LubaDevice.actionPlanAndStartMowing), not this builder's; this function just encodes
 * whatever hash list it's given.
 *
 * Route parameters this app doesn't yet expose as options (channel width/mode, ultrasonic
 * sensitivity, heading) use the same fixed defaults pymammotion's OperationSettings does —
 * matching the "not exposed yet" set already deferred for the same reason in
 * StartMowOptions/CLAUDE.md's Phase 3+ backlog.
 */
export function buildGenerateRouteCommand(
  areas: string[],
  options: Pick<StartMowOptions, 'bladeHeight' | 'speed'>,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
  productKey?: string,
): string {
  const receiver = isLubaProDevice(deviceName, productKey) ? MsgDevice.DEV_NAVIGATION : MsgDevice.DEV_MAINCTL;
  return encodeLubaMsgBase64({
    ...envelope(MsgCmdType.NAV, receiver, userAccount, seq),
    nav: {
      bidireReqconverPath: {
        pver: 1,
        subCmd: 0,
        zoneHashs: areas,
        jobMode: 4,
        edgeMode: 1,
        knifeHeight: Math.trunc(options.bladeHeight ?? 25),
        channelWidth: 25,
        UltraWave: 2,
        channelMode: 0,
        toward: 0,
        speed: options.speed ?? 0.3,
        towardMode: 0,
        towardIncludedAngle: 0,
        reserved: createPathOrder(),
      },
    },
  });
}
