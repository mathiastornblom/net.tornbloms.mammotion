/**
 * BluFi-derived BLE frame codec, ported from pymammotion's `bluetooth/ble_message.py`
 * (`BleMessage`, `FrameCtrlData`, `BlufiNotifyData`). Mammotion's ESP32 BLE module reuses
 * Espressif's BluFi provisioning wire format rather than a bespoke one — confirmed by
 * `EspBleUtil` references in pymammotion's own source comments.
 *
 * Frame layout: [type:1][frameCtrl:1][sequence:1][dataLength:1][data:N][checksum:2 if set]
 * See docs/BLE_PLAN.md for the full analysis. UNVERIFIED against a real device — see that
 * doc's "open questions" before trusting chunk size or fragment-offset behaviour blindly.
 */

/** package type bits (0–1 of the type byte): 0 = ctrl/ack, 1 = data. */
export const PACKAGE_TYPE_DATA = 1;
/** sub type (bits 2–7 of the type byte) for our custom protobuf payload. */
export const SUB_TYPE_CUSTOM_DATA = 19;

/** Conservative default — pymammotion assumes a negotiated 517-byte ATT_MTU; Homey's BLE API
 *  doesn't expose MTU negotiation, so start at the BLE 4.0 minimum until verified safe to raise. */
export const DEFAULT_CHUNK_SIZE = 20;

/** Decoded frame-control flag byte that prefixes every BluFi frame. */
export interface FrameCtrl {
  encrypted: boolean;
  checksum: boolean;
  /** direction bit: 0 = app→device (the only direction we send). */
  direction: 0 | 1;
  requireAck: boolean;
  hasFrag: boolean;
}

/** Pack frame-control flags into the single frameCtrl byte (FrameCtrlData.getFrameCTRLValue). */
export function encodeFrameCtrl(ctrl: FrameCtrl): number {
  let value = 0;
  if (ctrl.encrypted) value |= 1;
  if (ctrl.checksum) value |= 2;
  if (ctrl.direction === 1) value |= 4;
  if (ctrl.requireAck) value |= 8;
  if (ctrl.hasFrag) value |= 16;
  return value;
}

/** Unpack the frameCtrl byte (FrameCtrlData.check/isX). */
export function decodeFrameCtrl(value: number): FrameCtrl {
  return {
    encrypted: (value & 1) !== 0,
    checksum: (value & 2) !== 0,
    direction: (value & 4) !== 0 ? 1 : 0,
    requireAck: (value & 8) !== 0,
    hasFrag: (value & 16) !== 0,
  };
}

/** Build the type byte: (subType << 2) | packageType (BleMessage.getTypeValue). */
export function encodeType(packageType: number, subType: number): number {
  return ((subType << 2) | packageType) & 0xff;
}

/** Split the type byte into [packageType, subType] (BleMessage._getPackageType/_getSubType). */
export function decodeType(typeByte: number): { packageType: number; subType: number } {
  return { packageType: typeByte & 3, subType: (typeByte & 252) >> 2 };
}

let sendSequence = -1;

/** Next send sequence number, wrapping at 255 (BleMessage.generate_send_sequence). Module-level
 *  to mirror pymammotion's single shared counter per BLE connection; reset on (re)connect. */
export function nextSendSequence(): number {
  sendSequence = (sendSequence + 1) & 0xff;
  return sendSequence;
}

/** Resets the shared send-sequence counter; call on every (re)connect. */
export function resetSendSequence(): void {
  sendSequence = -1;
}

/**
 * Build the BLE frames to write for a payload, applying the BluFi header and fragmenting if the
 * payload exceeds chunkSize (BleMessage.post_contains_data/getPostBytes). Returns one Buffer per
 * GATT write — caller writes them in order (the device reassembles by sequence/hasFrag).
 */
export function buildFrames(
  payload: Buffer,
  opts: { packageType?: number; subType?: number; chunkSize?: number } = {},
): Buffer[] {
  const packageType = opts.packageType ?? PACKAGE_TYPE_DATA;
  const subType = opts.subType ?? SUB_TYPE_CUSTOM_DATA;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const typeByte = encodeType(packageType, subType);

  const chunks: Buffer[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.subarray(i, Math.min(i + chunkSize, payload.length)));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const frameCtrl = encodeFrameCtrl({
      encrypted: false,
      checksum: false,
      direction: 0,
      requireAck: false,
      hasFrag: !isLast,
    });
    const sequence = nextSendSequence();
    const header = Buffer.from([typeByte, frameCtrl, sequence, chunk.length]);
    return Buffer.concat([header, chunk]);
  });
}

/** Outcome of feeding one raw notification frame into BlufiFrameAssembler.push(). */
export type FrameResult =
  | { kind: 'complete'; packageType: number; subType: number; data: Buffer }
  | { kind: 'fragment' }
  | { kind: 'duplicate' }
  | { kind: 'error'; reason: string };

/**
 * Stateful reassembler for incoming notification frames (BlufiNotifyData + BleMessage's
 * parseNotification/parseBlufiNotifyData). One instance per BLE connection — call `reset()` on
 * (re)connect alongside `resetSendSequence()`.
 */
export class BlufiFrameAssembler {
  private readSequence = -1;
  private chunks: Buffer[] = [];
  private packageType = 0;
  private subType = 0;

  /** Clears reassembly state; call on every (re)connect alongside resetSendSequence(). */
  reset(): void {
    this.readSequence = -1;
    this.chunks = [];
  }

  /** Feed one raw BLE notification payload. Returns the outcome for this frame. */
  push(response: Buffer): FrameResult {
    if (response.length < 4) return { kind: 'error', reason: 'frame shorter than 4-byte header' };

    const sequence = response[2];
    const currentSequence = this.readSequence & 0xff;
    if (sequence === currentSequence) return { kind: 'duplicate' };

    const expected = (this.readSequence + 1) & 0xff;
    if (sequence !== expected) {
      // Mirrors pymammotion: log-worthy but not fatal — resync to whatever the device sent.
      this.readSequence = sequence;
    } else {
      this.readSequence = expected;
    }

    const typeByte = response[0];
    const { packageType, subType } = decodeType(typeByte);
    const frameCtrl = decodeFrameCtrl(response[1]);
    const dataLen = response[3];
    const dataBytes = response.subarray(4, 4 + dataLen);

    if (frameCtrl.checksum) {
      const respChecksum1 = response[response.length - 2];
      const respChecksum2 = response[response.length - 1];
      const crc = calcCrc(calcCrc(0, Buffer.from([sequence, dataLen])), dataBytes);
      const calc1 = (crc >> 8) & 0xff;
      const calc2 = crc & 0xff;
      if (respChecksum1 !== calc1 || respChecksum2 !== calc2) {
        return { kind: 'error', reason: 'checksum mismatch' };
      }
    }

    // Mirrors BlufiNotifyData.addData's literal offset behaviour: a fragmented (non-final)
    // frame's data begins with a 2-byte field that is skipped before accumulating.
    const offset = frameCtrl.hasFrag ? 2 : 0;
    if (this.chunks.length === 0) {
      this.packageType = packageType;
      this.subType = subType;
    }
    this.chunks.push(dataBytes.subarray(Math.min(offset, dataBytes.length)));

    if (frameCtrl.hasFrag) return { kind: 'fragment' };

    const data = Buffer.concat(this.chunks);
    const result: FrameResult = { kind: 'complete', packageType: this.packageType, subType: this.subType, data };
    this.chunks = [];
    return result;
  }
}

const CRC_TABLE: readonly number[] = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7, 0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
  0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6, 0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
  0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485, 0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
  0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4, 0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
  0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823, 0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
  0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12, 0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
  0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41, 0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
  0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70, 0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
  0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f, 0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
  0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e, 0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
  0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d, 0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
  0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c, 0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
  0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab, 0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
  0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a, 0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
  0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9, 0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
  0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8, 0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
];

/** CRC16 used only when frameCtrl.checksum is set (BleMessage.calc_crc) — not used by default. */
export function calcCrc(initial: number, data: Buffer): number {
  let crc = (~initial) & 0xffff;
  for (const byte of data) {
    crc = ((crc << 8) ^ CRC_TABLE[byte ^ (crc >> 8)]) & 0xffff;
  }
  return (~crc) & 0xffff;
}
