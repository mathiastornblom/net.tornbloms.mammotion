'use strict';

import https from 'https';
import { createHash, createHmac, randomUUID } from 'crypto';

import {
  getCaSignature, getContentMd5, getDateUtcString, getNonce,
} from './signing.js';
import {
  ALIYUN_APP_KEY, ALIYUN_APP_SECRET, ALIYUN_APP_VERSION, ALIYUN_CONNECT_DOMAIN,
  ALIYUN_DOMAIN, ALIYUN_SDK_VERSION,
} from './constants.js';
import type {
  AliyunAccountDevice, AliyunAepResponse, AliyunConnectResponse, AliyunListingDevAccountResponse,
  AliyunLoginByOAuthResponse, AliyunRegionResponse, AliyunSessionByAuthCodeResponse,
  AliyunShareNoticeListResponse,
} from './types.js';
import type { AuthSession } from '../auth/types.js';

/** Stable-per-account, differs-across-accounts filler string — mirrors pymammotion's
 *  hardware-fingerprint fields (clientId/deviceSn/utdid) without depending on host NIC
 *  identity, which isn't meaningful inside Homey's sandboxed runtime. */
function generateHardwareString(length: number, seed: string): string {
  const hash = createHash('sha1').update(`homey-mammotion:${seed}`, 'utf8').digest('hex');
  let out = '';
  while (out.length < length) out += hash;
  return out.slice(0, length);
}

/** Minimal HTTPS POST-and-parse-JSON helper, independent of MammotionAuth's (different
 *  header/auth shape entirely — no Bearer token, Aliyun's own signature headers instead). */
function httpsRequestJson<T>(opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<T> {
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
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
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

/** Builds and signs one IoTApiRequest-shaped call through the Aliyun API Gateway CA-signature
 *  scheme (region/aep/session/list/notice calls only — connect() and loginByOAuth() use their
 *  own bespoke signing and are implemented separately below). */
async function signedGatewayRequest<T>(opts: {
  domain: string;
  pathname: string;
  apiVer: string;
  params: Record<string, unknown>;
  iotToken?: string;
}): Promise<T> {
  const {
    domain, pathname, apiVer, params, iotToken,
  } = opts;
  const requestBody = {
    id: randomUUID(),
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

  return httpsRequestJson<T>({
    hostname: domain,
    path: `${pathname}?x-ca-request-id=${requestId}`,
    method: 'POST',
    headers,
    body: bodyJson,
  });
}

// ─── Step 1: region lookup ───────────────────────────────────────────────────

async function getRegion(countryCode: string, authCode: string): Promise<AliyunRegionResponse> {
  const resp = await signedGatewayRequest<AliyunRegionResponse>({
    domain: ALIYUN_DOMAIN,
    pathname: '/living/account/region/get',
    apiVer: '1.0.2',
    params: { authCode, type: 'THIRD_AUTHCODE', countryCode },
  });
  if (resp.code !== 200) throw new Error(`getRegion failed: code=${resp.code}`);
  return resp;
}

// ─── Step 2: connect (hardcoded domain, bespoke signing, no content-md5) ────

async function connectDevice(utdid: string): Promise<AliyunConnectResponse> {
  const bodyParam = {
    context: {
      sdkVersion: ALIYUN_SDK_VERSION,
      platformName: 'android',
      netType: 'wifi',
      appKey: ALIYUN_APP_KEY,
      yunOSId: '',
      appVersion: ALIYUN_APP_VERSION,
      utDid: utdid,
      appAuthToken: utdid,
      securityToken: utdid,
    },
    config: { version: 0, lastModify: 0 },
    device: { model: 'sdk_gphone_x86_arm', brand: 'goldfish_x86', platformVersion: '30' },
  };
  const bodyJson = JSON.stringify(bodyParam);
  const pathname = '/api/prd/connect.json';

  const headers: Record<string, string> = {
    host: ALIYUN_CONNECT_DOMAIN,
    date: getDateUtcString(),
    'x-ca-nonce': getNonce(),
    'x-ca-key': ALIYUN_APP_KEY,
    'x-ca-signaturemethod': 'HmacSHA256',
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'homey-mammotion',
  };
  const { signature, signatureHeaders } = getCaSignature({
    method: 'POST', pathname, headers, query: { request: bodyJson }, secret: ALIYUN_APP_SECRET,
  });
  headers['x-ca-signature'] = signature;
  headers['x-ca-signature-headers'] = signatureHeaders;

  return httpsRequestJson<AliyunConnectResponse>({
    hostname: ALIYUN_CONNECT_DOMAIN,
    path: `${pathname}?request=${encodeURIComponent(bodyJson)}`,
    method: 'POST',
    headers,
  });
}

// ─── Step 3: OAuth login against the region's own gateway endpoint ──────────

async function loginByOAuth(
  countryCode: string, authCode: string, region: AliyunRegionResponse,
  connect: AliyunConnectResponse, utdid: string,
): Promise<AliyunLoginByOAuthResponse> {
  const host = region.data.oaApiGatewayEndpoint;
  const bodyParam = {
    country: countryCode,
    authCode,
    oauthPlateform: 23,
    oauthAppKey: ALIYUN_APP_KEY,
    riskControlInfo: {
      appID: 'com.agilexrobotics',
      appAuthToken: '',
      signType: 'RSA',
      sdkVersion: ALIYUN_SDK_VERSION,
      utdid,
      umidToken: utdid,
      deviceId: connect.data.data.device.data.deviceId,
      USE_OA_PWD_ENCRYPT: 'true',
      USE_H5_NC: 'true',
    },
  };
  const bodyJson = JSON.stringify(bodyParam);
  const pathname = '/api/prd/loginbyoauth.json';

  const headers: Record<string, string> = {
    host,
    date: getDateUtcString(),
    'x-ca-nonce': getNonce(),
    'x-ca-key': ALIYUN_APP_KEY,
    'x-ca-signaturemethod': 'HmacSHA256',
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    'user-agent': 'homey-mammotion',
    vid: connect.data.vid,
  };
  const { signature, signatureHeaders } = getCaSignature({
    method: 'POST', pathname, headers, query: { loginByOauthRequest: bodyJson }, secret: ALIYUN_APP_SECRET,
  });
  headers['x-ca-signature'] = signature;
  headers['x-ca-signature-headers'] = signatureHeaders;

  const form = `loginByOauthRequest=${encodeURIComponent(bodyJson)}`;
  headers['content-length'] = String(Buffer.byteLength(form));
  return httpsRequestJson<AliyunLoginByOAuthResponse>({
    hostname: host, path: pathname, method: 'POST', headers, body: form,
  });
}

// ─── Step 4: AEP device-registration handshake ──────────────────────────────

async function aepHandle(region: AliyunRegionResponse, clientId: string, deviceSn: string): Promise<AliyunAepResponse> {
  const timestamp = String(Date.now() / 1000);
  const signSource = `appKey${ALIYUN_APP_KEY}clientId${clientId}deviceSn${deviceSn}timestamp${timestamp}`;
  const sign = createHmac('sha1', ALIYUN_APP_SECRET).update(signSource, 'utf8').digest('hex');

  const resp = await signedGatewayRequest<AliyunAepResponse>({
    domain: region.data.apiGatewayEndpoint,
    pathname: '/app/aepauth/handle',
    apiVer: '1.0.0',
    params: {
      authInfo: {
        clientId, sign, deviceSn, timestamp,
      },
    },
  });
  if (resp.code !== 200) throw new Error(`aepHandle failed: code=${resp.code}`);
  return resp;
}

// ─── Step 5: exchange the OAuth session id for an iotToken ──────────────────

async function sessionByAuthCode(region: AliyunRegionResponse, oauth: AliyunLoginByOAuthResponse): Promise<string> {
  const sid = oauth.data.data?.loginSuccessResult.sid;
  if (!sid) throw new Error('loginByOAuth response missing sid');
  const resp = await signedGatewayRequest<AliyunSessionByAuthCodeResponse>({
    domain: region.data.apiGatewayEndpoint,
    pathname: '/account/createSessionByAuthCode',
    apiVer: '1.0.4',
    params: { request: { authCode: sid, accountType: 'OA_SESSION', appKey: ALIYUN_APP_KEY } },
  });
  if (resp.code !== 200 || !resp.data?.iotToken) throw new Error(`sessionByAuthCode failed: code=${resp.code}`);
  return resp.data.iotToken;
}

// ─── Step 6: the actual read-only lookups ────────────────────────────────────

async function listBindingByAccount(region: AliyunRegionResponse, iotToken: string): Promise<AliyunListingDevAccountResponse> {
  return signedGatewayRequest<AliyunListingDevAccountResponse>({
    domain: region.data.apiGatewayEndpoint,
    pathname: '/uc/listBindingByAccount',
    apiVer: '1.0.8',
    params: { pageSize: 100, pageNo: 1 },
    iotToken,
  });
}

async function getShareNoticeList(region: AliyunRegionResponse, iotToken: string): Promise<AliyunShareNoticeListResponse> {
  return signedGatewayRequest<AliyunShareNoticeListResponse>({
    domain: region.data.apiGatewayEndpoint,
    pathname: '/uc/getShareNoticeList',
    apiVer: '1.0.9',
    params: { pageSize: 100, pageNo: 1 },
    iotToken,
  });
}

/**
 * Diagnostic-only probe for the legacy Alibaba Cloud IoT Link Platform account/device
 * system — a SECOND, completely independent Mammotion device-sharing/listing mechanism
 * (separate signed-request scheme, separate servers) from the one MammotionAuth.ts uses.
 * See [[architecture-decisions]] #14b in project memory for the full "why does this exist"
 * writeup, and the 6-step sequence this mirrors: pymammotion's `Client._connect_iot()`.
 *
 * Scope, deliberately: this ONLY answers "does this account have any devices visible
 * through the legacy system" — it does NOT confirm pending shares, does NOT set up an
 * Aliyun MQTT transport, and does NOT enable control of any device found this way. A
 * positive result here means the legacy transport would need to be built (a substantially
 * larger effort) before those devices could actually be paired — this probe exists purely
 * to confirm or rule out that need cheaply, without asking any user to capture their own
 * network traffic.
 *
 * Ported by reading pymammotion's `aliyun/cloud_gateway.py` + `aliyun/client.py` source
 * (no vendored Python, no live legacy-bound test account to verify against) — a bug in the
 * signing here fails closed (probe result treated as "not legacy", see acceptPendingShares
 * callers), never blocks normal pairing.
 */
export interface LegacyProbeResult {
  /** Devices visible via /uc/listBindingByAccount (owned + already-accepted shares). */
  boundDevices: AliyunAccountDevice[];
  /** Devices with an outstanding (any status) share notification, from /uc/getShareNoticeList. */
  shareNotifications: number;
}

/** Runs the full legacy handshake and returns what it found. Throws on any step failure —
 *  callers must treat this as best-effort and catch. */
export async function probeLegacyAliyunDevices(session: AuthSession): Promise<LegacyProbeResult> {
  if (!session.authorizationCode) throw new Error('No authorizationCode on session — cannot start Aliyun handshake');
  const countryCode = session.countryCode || 'US';

  const clientId = generateHardwareString(8, session.userId);
  const deviceSn = generateHardwareString(32, session.userId);
  const utdid = generateHardwareString(32, session.userId);

  const region = await getRegion(countryCode, session.authorizationCode);
  const connect = await connectDevice(utdid);
  const oauth = await loginByOAuth(countryCode, session.authorizationCode, region, connect, utdid);
  // aep_handle is run for parity with the reference sequence (some accounts' session step
  // depends on the device-registration side effect it has server-side) — its own response
  // (device credentials) isn't needed for a read-only listing call, so it's discarded.
  await aepHandle(region, clientId, deviceSn);
  const iotToken = await sessionByAuthCode(region, oauth);

  const bound = await listBindingByAccount(region, iotToken);
  const notices = await getShareNoticeList(region, iotToken).catch(() => ({ code: 0, data: null }));

  return {
    boundDevices: bound.data?.data ?? [],
    shareNotifications: notices.data?.total ?? 0,
  };
}
