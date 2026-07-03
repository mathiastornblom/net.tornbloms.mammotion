'use strict';

import https from 'https';
import { randomUUID } from 'crypto';

import {
  getCaSignature, getContentMd5, getDateUtcString, getNonce,
} from './signing.js';
import { ALIYUN_APP_KEY, ALIYUN_APP_SECRET } from './constants.js';

/**
 * Shared plumbing for every Aliyun API Gateway CA-signature-scheme call this app makes —
 * region/aep/session/list/notice/invoke. `connect()` and `loginByOAuth()` in
 * AliyunLegacyProbe.ts use their own bespoke signing and don't go through this module.
 * See docs/ALIYUN_LEGACY_PLAN.md and docs/ALIYUN_MQTT_TRANSPORT_PLAN.md for the full
 * protocol writeup — this file is deliberately just the transport plumbing, no endpoint
 * knowledge.
 */

/** Same as httpsRequestJson but also exposes the HTTP status code — needed by callers that
 *  must distinguish a gateway-level HTTP 429 from the JSON body's own `code` field (e.g.
 *  sendAliyunCloudCommand in commands.ts, mirroring pymammotion's send_cloud_command). */
export function httpsRequestJsonWithStatus<T>(opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
            });
          } catch (e) {
            reject(new Error(`Aliyun response was not valid JSON (status ${res.statusCode}): ${String(e)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Minimal HTTPS POST-and-parse-JSON helper, independent of MammotionAuth's (different
 *  header/auth shape entirely — no Bearer token, Aliyun's own signature headers instead). */
export function httpsRequestJson<T>(opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<T> {
  return httpsRequestJsonWithStatus<T>(opts).then((res) => res.body);
}

/** Pure request-building step of signedGatewayRequest, split out so callers/tests can
 *  inspect the exact hostname/path/headers/body that would be sent without performing
 *  network I/O — mirrors how getCaSignature is made independently testable. */
export function buildSignedGatewayRequest(opts: {
  domain: string;
  pathname: string;
  apiVer: string;
  params: Record<string, unknown>;
  iotToken?: string;
  /** Overrides the generated `id` field of the request envelope — callers that need to know
   *  this id ahead of time (e.g. sendAliyunCloudCommand returning pymammotion's
   *  client-generated message id) can supply their own instead of a fresh randomUUID(). */
  messageId?: string;
}): {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  const {
    domain, pathname, apiVer, params, iotToken, messageId,
  } = opts;
  const requestBody = {
    id: messageId ?? randomUUID(),
    version: '1.0',
    params,
    request: { apiVer, iotToken, language: 'en-US' },
  };
  const bodyJson = JSON.stringify(requestBody);
  const contentMd5 = getContentMd5(bodyJson);
  const requestId = randomUUID();

  const headers: Record<string, string> = {
    host: domain,
    date: getDateUtcString(),
    'x-ca-nonce': getNonce(),
    'x-ca-key': ALIYUN_APP_KEY,
    'x-ca-signaturemethod': 'HmacSHA256',
    accept: 'application/json; charset=utf-8',
    'x-ca-timestamp': `${Date.now()}000000`,
    'content-type': 'application/octet-stream',
    'content-md5': contentMd5,
    'user-agent': 'ALIYUN-ANDROID-DEMO',
  };
  const { signature, signatureHeaders } = getCaSignature({
    method: 'POST', pathname, headers, query: { 'x-ca-request-id': requestId }, secret: ALIYUN_APP_SECRET,
  });
  headers['x-ca-signature'] = signature;
  headers['x-ca-signature-headers'] = signatureHeaders;
  headers.ca_version = '1';
  headers['content-length'] = String(Buffer.byteLength(bodyJson));

  return {
    hostname: domain,
    path: `${pathname}?x-ca-request-id=${requestId}`,
    method: 'POST',
    headers,
    body: bodyJson,
  };
}

/** Builds and signs one IoTApiRequest-shaped call through the Aliyun API Gateway CA-signature
 *  scheme (region/aep/session/list/notice/invoke calls — connect() and loginByOAuth() in
 *  AliyunLegacyProbe.ts use their own bespoke signing and are implemented separately there). */
export async function signedGatewayRequest<T>(opts: {
  domain: string;
  pathname: string;
  apiVer: string;
  params: Record<string, unknown>;
  iotToken?: string;
}): Promise<T> {
  return httpsRequestJson<T>(buildSignedGatewayRequest(opts));
}

/** Same as signedGatewayRequest but also exposes the HTTP status code — needed to detect a
 *  gateway-level HTTP 429 separately from the JSON body's own `code` field. */
export async function signedGatewayRequestWithStatus<T>(opts: {
  domain: string;
  pathname: string;
  apiVer: string;
  params: Record<string, unknown>;
  iotToken?: string;
  messageId?: string;
}): Promise<{ statusCode: number; body: T }> {
  return httpsRequestJsonWithStatus<T>(buildSignedGatewayRequest(opts));
}
