'use strict';

import { randomUUID } from 'crypto';

import { signedGatewayRequestWithStatus } from './gateway.js';
import { AliyunCommandError } from '../errors.js';
import type { AliyunLegacyCredentials } from './AliyunLegacyProbe.js';
import type { AliyunInvokeResponse } from './types.js';

/**
 * Write path for legacy-Aliyun-bound devices — sends a protobuf-encoded LubaMsg command via
 * the same CA-signature-scheme gateway already proven working by AliyunLegacyProbe.ts's read
 * path, POSTing to /thing/service/invoke. Ported from pymammotion's
 * `CloudIOTGateway.send_cloud_command` (pymammotion/aliyun/cloud_gateway.py, confirmed against
 * source 2026-07-03) — see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md section 2 for the full writeup.
 *
 * Command builders in lib/mammotion/commands/LubaCommands.ts are unchanged and reusable as-is
 * for this transport — they only produce base64-encodable protobuf bytes, with no knowledge
 * of which cloud system delivers them.
 */

/** Aliyun error codes pymammotion special-cases when sending a cloud command — mirrored here
 *  purely for documentation; every non-200 code still throws AliyunCommandError, callers that
 *  need to branch on a specific code should inspect `error.code`. */
export const ALIYUN_INVOKE_CODE = {
  OK: 200,
  DEVICE_OFFLINE: 6205,
  DEVICE_UNBOUND: 29004,
  IDENTITY_BLANK: 29003,
  IOT_TOKEN_EXPIRED: 460,
} as const;

/** Params shape for the /thing/service/invoke call — the pure part of building the request,
 *  split out so it can be unit-tested without performing any network I/O (mirrors how
 *  buildSignedGatewayRequest / getCaSignature are made independently testable). */
export function buildInvokeParams(iotId: string, commandBytes: Buffer): Record<string, unknown> {
  return {
    args: { content: commandBytes.toString('base64') },
    identifier: 'device_protobuf_sync_service',
    iotId,
  };
}

/** Sends a protobuf command to a legacy-Aliyun-bound device and returns the message id that
 *  was assigned to the request (matching pymammotion's `send_cloud_command`, which returns
 *  its own client-generated `id` — not anything read back from the response body). Throws
 *  AliyunCommandError on a non-200 JSON `code` (including the specific codes pymammotion
 *  special-cases: 6205 device offline, 29004 device unbound, 29003/460 auth expired) or on an
 *  HTTP-level 429 (rate limited) — matching pymammotion's behavior of checking both the HTTP
 *  status and the JSON body's `code` field. Does not implement pymammotion's rate-limit
 *  circuit breaker or token-refresh pre-check (docs/ALIYUN_MQTT_TRANSPORT_PLAN.md Stage 3) —
 *  callers must handle AliyunCommandError with code 429/29003/460 by re-probing/
 *  re-authenticating as needed. */
export async function sendAliyunCloudCommand(
  credentials: AliyunLegacyCredentials,
  iotId: string,
  commandBytes: Buffer,
): Promise<string> {
  const messageId = randomUUID();
  const { statusCode, body } = await signedGatewayRequestWithStatus<AliyunInvokeResponse>({
    domain: credentials.apiGatewayEndpoint,
    pathname: '/thing/service/invoke',
    apiVer: '1.0.5',
    params: buildInvokeParams(iotId, commandBytes),
    iotToken: credentials.iotToken,
    messageId,
  });

  if (statusCode === 429) {
    throw new AliyunCommandError(429, 'Too many requests — rate limited by Aliyun gateway');
  }

  const code = body?.code ?? 0;
  if (code !== ALIYUN_INVOKE_CODE.OK) {
    throw new AliyunCommandError(code, body?.message ?? `Aliyun invoke returned code ${code}`);
  }

  return messageId;
}
