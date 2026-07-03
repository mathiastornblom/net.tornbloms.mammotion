'use strict';

import { createHash, createHmac } from 'crypto';

import { getCaSignature, getDateUtcString, getNonce } from './signing.js';
import { httpsRequestJson, signedGatewayRequest } from './gateway.js';
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
 * (no vendored Python originally, since confirmed working against a live legacy-bound
 * account — see docs/ALIYUN_LEGACY_PLAN.md "hypothesis confirmed" and
 * docs/ALIYUN_MQTT_TRANSPORT_PLAN.md for the read+write implementation built on top of
 * this). A bug in the signing here fails closed (probe result treated as "not legacy",
 * see acceptPendingShares callers), never blocks normal pairing.
 */
/** Everything device.ts / LubaDriver needs to construct the shared AliyunMqttTransport and
 *  send commands, without re-running the full 6-step handshake each time. `iotToken` is
 *  short-lived (see AliyunSessionByAuthCodeResponse.iotTokenExpire) — callers that hold
 *  onto this across a long-lived session must re-probe or implement token refresh
 *  (docs/ALIYUN_MQTT_TRANSPORT_PLAN.md Stage 3), not assume it stays valid indefinitely. */
export interface AliyunLegacyCredentials {
  /** apiGatewayEndpoint for this account's region — base domain for signedGatewayRequest
   *  calls (list/notice/invoke) and for deriving the MQTT broker host. */
  apiGatewayEndpoint: string;
  /** Aliyun region id (e.g. "cn-shanghai") — used to build the MQTT broker hostname
   *  `${productKey}.iot-as-mqtt.${regionId}.aliyuncs.com`. */
  regionId: string;
  /** This ACCOUNT's own AEP-registered identity (not any individual mower's) — used for
   *  both the account-level MQTT connection credentials and topic namespace. See
   *  docs/ALIYUN_MQTT_TRANSPORT_PLAN.md's "one connection per account" correction. */
  deviceSecret: string;
  productKey: string;
  deviceName: string;
  /** Short-lived session token for signedGatewayRequest calls and the MQTT bind message. */
  iotToken: string;
}

export interface LegacyProbeResult {
  /** Devices visible via /uc/listBindingByAccount (owned + already-accepted shares). */
  boundDevices: AliyunAccountDevice[];
  /** Devices with an outstanding (any status) share notification, from /uc/getShareNoticeList. */
  shareNotifications: number;
  /** Account-level credentials needed to build the shared AliyunMqttTransport / send
   *  commands via sendAliyunCloudCommand — undefined only if aepHandle's response was
   *  somehow missing required fields (treat as "legacy support unavailable this attempt"). */
  credentials?: AliyunLegacyCredentials;
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
  const aep = await aepHandle(region, clientId, deviceSn);
  const iotToken = await sessionByAuthCode(region, oauth);

  const bound = await listBindingByAccount(region, iotToken);
  const notices = await getShareNoticeList(region, iotToken).catch(() => ({ code: 0, data: null }));

  const credentials: AliyunLegacyCredentials | undefined = aep.data
    ? {
      apiGatewayEndpoint: region.data.apiGatewayEndpoint,
      regionId: region.data.regionId,
      deviceSecret: aep.data.deviceSecret,
      productKey: aep.data.productKey,
      deviceName: aep.data.deviceName,
      iotToken,
    }
    : undefined;

  return {
    boundDevices: bound.data?.data ?? [],
    shareNotifications: notices.data?.total ?? 0,
    credentials,
  };
}
