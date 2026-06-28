'use strict';

import {
  encodeFieldVarint,
  encodeFieldBytes,
  encodeFieldFloat32,
  encodeFieldInt32,
  encodeFieldFixed64,
  encodeFieldString,
  encodeMessage,
} from '../protocol/Codec';
import { DEV_MAINCTL, DEV_MOBILEAPP, DEV_NAVIGATION } from '../constants';

export type DeviceCommand = 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock';

export interface StartMowOptions {
  isMow?: boolean;
  isDump?: boolean;
  isEdge?: boolean;
  bladeHeight?: number;
  speed?: number;
  channelWidthCm?: number;
  channelMode?: 0 | 1 | 2 | 3;
  rainTactics?: 0 | 1;
  areaHashes?: bigint[];
  jobMode?: number;
  mowingLaps?: number;
  borderMode?: 0 | 1;
  obstacleLaps?: number;
  startProgress?: number;
  ultraWave?: number;
  towardDeg?: number;
  towardMode?: number;
  towardIncludedAngleDeg?: number;
}

/** Whether the device is a Luba Pro (DEV_NAVIGATION receiver instead of DEV_MAINCTL). */
export function isLubaProDevice(deviceName: string): boolean {
  const lower = deviceName.toLowerCase();
  return lower.includes('luba pro') || lower.includes('lubapro');
}

function commandToAction(command: DeviceCommand): number {
  switch (command) {
    case 'start': return 1;
    case 'pause': return 2;
    case 'resume': return 3;
    case 'stop':
    case 'cancelJob': return 4;
    case 'dock': return 5;
    case 'cancelDock': return 12;
  }
}

/** Build a LubaMsg envelope and return it as a base64 string for the MQTT invoke API. */
function buildLubaMessage(args: {
  msgType: number;
  receiverDevice: number;
  subtype: number;
  subMessageField: number;
  subMessagePayload: Buffer;
  seq: { value: number };
}): Buffer {
  const now = BigInt(Date.now());
  args.seq.value = (args.seq.value + 1) & 0xff;

  return Buffer.concat([
    encodeMessage([
      encodeFieldVarint(1, args.msgType),
      encodeFieldVarint(2, DEV_MOBILEAPP),
      encodeFieldVarint(3, args.receiverDevice),
      encodeFieldVarint(4, 1),
      encodeFieldVarint(5, args.seq.value),
      encodeFieldVarint(6, 1),
      encodeFieldVarint(7, args.subtype),
      encodeFieldBytes(args.subMessageField, args.subMessagePayload),
      encodeFieldVarint(15, now),
    ]),
  ]);
}

/** Build a start/stop/dock/pause task control command. */
export function buildTaskControlCommand(
  command: DeviceCommand,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
): string {
  const action = commandToAction(command);
  const subtype = parseInt(userAccount, 10) || 0;
  const receiver = isLubaProDevice(deviceName) ? DEV_NAVIGATION : DEV_MAINCTL;

  const taskCtrl = encodeMessage([
    encodeFieldVarint(1, 1),
    encodeFieldVarint(2, action),
    encodeFieldVarint(3, 0),
  ]);
  const nav = encodeMessage([encodeFieldBytes(37, taskCtrl)]);

  seq.value = (seq.value + 1) & 0xff;
  const msg = encodeMessage([
    encodeFieldVarint(1, 240),
    encodeFieldVarint(2, DEV_MOBILEAPP),
    encodeFieldVarint(3, receiver),
    encodeFieldVarint(4, 1),
    encodeFieldVarint(5, seq.value),
    encodeFieldVarint(6, 1),
    encodeFieldVarint(7, subtype),
    encodeFieldBytes(11, nav),
    encodeFieldVarint(15, BigInt(Date.now())),
  ]);
  return msg.toString('base64');
}

/** Build a route planning / start mowing command with full options. */
export function buildStartMowCommand(
  options: StartMowOptions,
  userAccount: string,
  deviceName: string,
  seq: { value: number },
): string {
  const subtype = parseInt(userAccount, 10) || 0;
  const receiver = isLubaProDevice(deviceName) ? DEV_NAVIGATION : DEV_MAINCTL;

  const routePayload: Buffer[] = [
    encodeFieldVarint(1, 1),
    encodeFieldVarint(4, options.jobMode ?? 0),
    encodeFieldVarint(5, 1),
    encodeFieldVarint(6, options.mowingLaps ?? 1),
    encodeFieldVarint(7, options.bladeHeight ?? 25),
    encodeFieldVarint(8, options.channelWidthCm ?? 25),
    encodeFieldVarint(9, options.ultraWave ?? 2),
    encodeFieldVarint(10, options.channelMode ?? 0),
    encodeFieldInt32(11, options.towardDeg ?? 0),
    encodeFieldFloat32(12, options.speed ?? 0.3),
    encodeFieldVarint(17, options.towardMode ?? 0),
    encodeFieldInt32(18, options.towardIncludedAngleDeg ?? 0),
    encodeFieldFloat32(19, 0),
  ];

  for (const hash of options.areaHashes ?? []) {
    routePayload.push(encodeFieldFixed64(13, hash));
  }

  // Reserved bytes: [borderMode, obstacleLaps, 0, startProgress, 0, 0, collectGrassFreq]
  const reserved = Buffer.alloc(8);
  reserved[0] = (options.borderMode ?? 1) & 0xff;
  reserved[1] = (options.obstacleLaps ?? 1) & 0xff;
  reserved[3] = (options.startProgress ?? 0) & 0xff;
  reserved[6] = options.isDump ? 10 : 10;
  routePayload.push(encodeFieldBytes(15, reserved));

  const nav = encodeMessage([encodeFieldBytes(34, encodeMessage(routePayload))]);

  return buildLubaMessage({
    msgType: 240,
    receiverDevice: receiver,
    subtype,
    subMessageField: 11,
    subMessagePayload: nav,
    seq,
  }).toString('base64');
}

/** Build a request for IoT sync (telemetry pull). */
export function buildRequestIotSyncCommand(
  userAccount: string,
  stop: boolean,
  seq: { value: number },
): string {
  const subtype = parseInt(userAccount, 10) || 0;
  const reportTypes = [1, 3, 4, 6, 10, 8];
  const reportCfgFields: Buffer[] = [
    encodeFieldVarint(1, stop ? 1 : 0),
    encodeFieldVarint(2, 10_000),
    encodeFieldVarint(3, 3_000),
    encodeFieldVarint(4, 4_000),
    encodeFieldVarint(5, 0),
  ];
  for (const t of reportTypes) reportCfgFields.push(encodeFieldVarint(6, t));

  const sys = encodeMessage([encodeFieldBytes(38, encodeMessage(reportCfgFields))]);
  seq.value = (seq.value + 1) & 0xff;

  return encodeMessage([
    encodeFieldVarint(1, 244),
    encodeFieldVarint(2, DEV_MOBILEAPP),
    encodeFieldVarint(3, DEV_MAINCTL),
    encodeFieldVarint(4, 1),
    encodeFieldVarint(5, seq.value),
    encodeFieldVarint(6, 1),
    encodeFieldVarint(7, subtype),
    encodeFieldBytes(10, sys),
    encodeFieldVarint(15, BigInt(Date.now())),
  ]).toString('base64');
}

/** Build a blade height + speed task settings command. */
export function buildTaskSettingsCommand(
  bladeHeightMm: number,
  mowSpeedMs: number,
  userAccount: string,
  seq: { value: number },
): string {
  const subtype = parseInt(userAccount, 10) || 0;
  const req = encodeMessage([
    encodeFieldVarint(3, Math.trunc(bladeHeightMm)),
    encodeFieldFloat32(4, mowSpeedMs),
  ]);
  const wrapper = encodeMessage([encodeFieldBytes(6, req)]);

  return encodeMessage([
    encodeFieldVarint(1, 243),
    encodeFieldVarint(2, DEV_MOBILEAPP),
    encodeFieldVarint(3, DEV_MAINCTL),
    encodeFieldVarint(5, 80),
    encodeFieldVarint(7, subtype),
    encodeFieldBytes(12, wrapper),
    encodeFieldVarint(15, BigInt(Date.now())),
  ]).toString('base64');
}
