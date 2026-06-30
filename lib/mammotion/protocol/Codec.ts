import protobuf from 'protobufjs';
import { protoDescriptor } from './generated/descriptor.js';

/**
 * Protobuf codec for the Mammotion LubaMsg envelope, backed by protobufjs reflection
 * over the vendored .proto definitions (see generated/descriptor.ts). This replaces
 * the previous hand-rolled byte codec, whose guessed field numbers caused telemetry
 * to be silently mis-encoded/mis-parsed.
 *
 * Field names on encoded/decoded objects are camelCase (protobufjs convention):
 * proto `todev_report_cfg` → `todevReportCfg`, `toapp_report_data` → `toappReportData`.
 */

/** MsgCmdType enum values (luba_msg.proto). */
export const MsgCmdType = {
  NAV: 240,
  PLANNING: 242,
  EMBED_DRIVER: 243,
  EMBED_SYS: 244,
  ESP: 248,
} as const;

/** MsgDevice enum values (luba_msg.proto). */
export const MsgDevice = {
  DEV_COMM_ESP: 0,
  DEV_MAINCTL: 1,
  DEV_MOBILEAPP: 7,
  DEV_NAVIGATION: 17,
} as const;

/** MsgAttr enum values (luba_msg.proto). */
export const MsgAttr = {
  REQ: 1,
} as const;

/** rpt_act enum values (mctrl_sys.proto). */
export const RptAct = {
  RPT_START: 0,
  RPT_STOP: 1,
  RPT_KEEP: 2,
} as const;

/** rpt_info_type enum values (mctrl_sys.proto). */
export const RptInfoType = {
  RIT_CONNECT: 0,
  RIT_DEV_STA: 1,
  RIT_RTK: 2,
  RIT_DEV_LOCAL: 3,
  RIT_WORK: 4,
  RIT_FW_INFO: 5,
  RIT_MAINTAIN: 6,
  RIT_VISION_POINT: 7,
  RIT_VIO: 8,
  RIT_VISION_STATISTIC: 9,
  RIT_BASESTATION_INFO: 10,
  RIT_CUTTER_INFO: 11,
} as const;

let cachedRoot: protobuf.Root | null = null;
let cachedLubaMsg: protobuf.Type | null = null;

/** Lazily build (and cache) the protobuf Root from the embedded descriptor. */
function getRoot(): protobuf.Root {
  if (!cachedRoot) {
    cachedRoot = protobuf.Root.fromJSON(protoDescriptor);
  }
  return cachedRoot;
}

/** Return the LubaMsg message type. */
export function getLubaMsgType(): protobuf.Type {
  if (!cachedLubaMsg) {
    cachedLubaMsg = getRoot().lookupType('LubaMsg');
  }
  return cachedLubaMsg;
}

/** Encode a LubaMsg plain object to protobuf bytes. */
export function encodeLubaMsg(payload: Record<string, unknown>): Buffer {
  const type = getLubaMsgType();
  const message = type.create(payload);
  return Buffer.from(type.encode(message).finish());
}

/** Encode a LubaMsg and return it base64-encoded (for the MQTT invoke API). */
export function encodeLubaMsgBase64(payload: Record<string, unknown>): string {
  return encodeLubaMsg(payload).toString('base64');
}

/**
 * Decode protobuf bytes into a LubaMsg plain object (camelCase fields).
 *
 * `defaults: true` is required: proto3 cannot distinguish "field not set" from
 * "field explicitly 0" on the wire, so protobufjs omits zero-valued fields from
 * the decoded object unless told otherwise. A legitimate 0 (e.g. man_run_speed=0
 * while stationary) would otherwise silently vanish instead of being reported.
 */
export function decodeLubaMsg(buf: Buffer): Record<string, unknown> {
  const type = getLubaMsgType();
  const message = type.decode(buf);
  return type.toObject(message, {
    longs: Number,
    enums: Number,
    defaults: true,
  });
}
