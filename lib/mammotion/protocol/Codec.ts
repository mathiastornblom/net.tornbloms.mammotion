'use strict';

/**
 * Manual protobuf encoding/decoding primitives.
 * We hand-encode LubaMsg rather than pulling in protobufjs for Phase 1,
 * since the command set is small and the binary format is fully understood
 * from the ioBroker TypeScript reference implementation.
 */

export function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) v = 0n;
  const bytes: number[] = [];
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

/** Varint field (wire type 0). */
export function encodeFieldVarint(fieldNumber: number, value: number | bigint): Buffer {
  const tag = (fieldNumber << 3) | 0;
  return Buffer.concat([encodeVarint(tag), encodeVarint(value)]);
}

/** Signed int32 as varint (handles negatives via two's complement extension to 64-bit). */
export function encodeFieldInt32(fieldNumber: number, value: number): Buffer {
  const tag = (fieldNumber << 3) | 0;
  let v = BigInt(Math.trunc(value));
  if (v < 0n) v = (1n << 64n) + v;
  return Buffer.concat([encodeVarint(tag), encodeVarint(v)]);
}

/** Length-delimited bytes field (wire type 2). */
export function encodeFieldBytes(fieldNumber: number, value: Buffer): Buffer {
  const tag = (fieldNumber << 3) | 2;
  return Buffer.concat([encodeVarint(tag), encodeVarint(value.length), value]);
}

/** String field (wire type 2). */
export function encodeFieldString(fieldNumber: number, value: string): Buffer {
  return encodeFieldBytes(fieldNumber, Buffer.from(value, 'utf8'));
}

/** Fixed 64-bit little-endian (wire type 1) — used for area hashes. */
export function encodeFieldFixed64(fieldNumber: number, value: bigint): Buffer {
  const tag = (fieldNumber << 3) | 1;
  const payload = Buffer.allocUnsafe(8);
  payload.writeBigUInt64LE(BigInt.asUintN(64, value), 0);
  return Buffer.concat([encodeVarint(tag), payload]);
}

/** 32-bit float little-endian (wire type 5). */
export function encodeFieldFloat32(fieldNumber: number, value: number): Buffer {
  const tag = (fieldNumber << 3) | 5;
  const payload = Buffer.allocUnsafe(4);
  payload.writeFloatLE(value, 0);
  return Buffer.concat([encodeVarint(tag), payload]);
}

/** Concatenate a list of field buffers into a length-prefixed message. */
export function encodeMessage(fields: Buffer[]): Buffer {
  const body = Buffer.concat(fields);
  return Buffer.concat([encodeVarint(body.length), body]);
}

// ─── Decoding helpers ────────────────────────────────────────────────────────

export interface DecodedField {
  fieldNumber: number;
  wireType: number;
  value: Buffer | bigint;
}

/** Decode all fields from a protobuf message buffer. Caller decides how to interpret. */
export function decodeMessage(buf: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const { value: rawTag, bytesRead: tagBytes } = readVarint(buf, offset);
    offset += tagBytes;
    const tag = Number(rawTag);
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const { value, bytesRead } = readVarint(buf, offset);
      offset += bytesRead;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 2) {
      const { value: lenRaw, bytesRead: lenBytes } = readVarint(buf, offset);
      offset += lenBytes;
      const len = Number(lenRaw);
      fields.push({ fieldNumber, wireType, value: buf.slice(offset, offset + len) });
      offset += len;
    } else if (wireType === 1) {
      fields.push({ fieldNumber, wireType, value: buf.readBigUInt64LE(offset) });
      offset += 8;
    } else if (wireType === 5) {
      fields.push({ fieldNumber, wireType, value: BigInt(buf.readUInt32LE(offset)) });
      offset += 4;
    } else {
      break; // unsupported wire type — stop to avoid infinite loop
    }
  }
  return fields;
}

function readVarint(buf: Buffer, offset: number): { value: bigint; bytesRead: number } {
  let result = 0n;
  let shift = 0n;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    bytesRead++;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result, bytesRead };
}

/** Extract a varint field value as a number from decoded fields. */
export function getVarintField(fields: DecodedField[], fieldNumber: number): number | null {
  const f = fields.find(x => x.fieldNumber === fieldNumber && x.wireType === 0);
  return f ? Number(f.value as bigint) : null;
}

/** Extract a bytes/string field from decoded fields. */
export function getBytesField(fields: DecodedField[], fieldNumber: number): Buffer | null {
  const f = fields.find(x => x.fieldNumber === fieldNumber && x.wireType === 2);
  return f ? (f.value as Buffer) : null;
}

/** Decode a bytes field as a UTF-8 string. */
export function getStringField(fields: DecodedField[], fieldNumber: number): string | null {
  const buf = getBytesField(fields, fieldNumber);
  return buf ? buf.toString('utf8') : null;
}
