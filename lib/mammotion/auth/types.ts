'use strict';

/** Generic envelope wrapping every Mammotion cloud API response. */
export interface MammotionApiResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/** Raw OAuth token response from the Mammotion login/refresh endpoint. */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  authorization_code?: string;
  userInformation?: {
    userId: string;
    userAccount: string;
    domainAbbreviation?: string;
  };
}

/** JWT-based MQTT broker connection credentials. */
export interface MqttConnection {
  host: string;
  clientId: string;
  username: string;
  jwt: string;
  /** Expiry unix timestamp in seconds. */
  expireTime?: number;
}

/** Device entry from the device/page endpoint — carries productKey and recordDeviceName needed for MQTT topics. */
export interface DeviceRecord {
  iotId: string;
  deviceId?: string;
  deviceName?: string;
  productKey?: string;
  status?: number;
}

/** Paginated wrapper around DeviceRecord returned by some account types. */
export interface DevicePageData {
  records: DeviceRecord[];
  total: number;
}

/** DeviceRecord list plus the raw pagination/response metadata, for pairing diagnostics. */
export interface DeviceRecordsResult {
  records: DeviceRecord[];
  /** Server-reported total, when the response is a DevicePageData wrapper. `null` if the
   *  response was a bare array (no pagination metadata) — distinguishes "API said 0 total"
   *  from "API doesn't report totals for this shape of response". */
  total: number | null;
  /** Response envelope's own message, e.g. "success" — useful when total/records disagree. */
  msg: string;
}

/**
 * Single record from the /user-server/v1/share/device/page endpoint — one pending or
 * resolved device-sharing invitation. Per pymammotion (the reference implementation this
 * app is ported from): `isReceiver: 1` means this account is the invitee (not the sharer),
 * and `status: -1` means the invitation is still pending confirmation. The mobile app's
 * "Accept" action calls the corresponding /confirm endpoint — a headless login flow (like
 * this app's) never triggers that unless it does so explicitly, which is why a share that
 * looks "accepted" client-side can still leave the account with zero visible devices.
 */
export interface ShareRecord {
  batchId: string;
  recordId: string;
  iotId: string;
  productKey?: string;
  deviceName?: string;
  isReceiver: number;
  status: number;
}

/** Paginated wrapper around ShareRecord. */
export interface ShareRecordsPage {
  records: ShareRecord[];
  total: number;
}

/** Device entry from the device/list endpoint — owned devices only (absent for shared-not-owned mowers). */
export interface MammotionDevice {
  iotId: string;
  deviceId?: string;
  deviceName?: string;
  deviceType?: number | string;
  series?: string;
  productSeries?: string;
  status?: number;
  locationVo?: { location?: number[] };
}

/** Resolved, post-login session stored in Homey settings. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt: number;
  /** Base URL of the IoT API domain, extracted from the JWT. */
  iotDomain: string;
  userId: string;
  /** Numeric string user account ID — used as protobuf subtype field. */
  userAccount: string;
  clientId: string;
  /** Mammotion's own OAuth authorization code from the login response — required as the
   *  `authCode` input to the separate, legacy Aliyun IoT Link Platform handshake (region
   *  lookup, OAuth login, session creation). Only used by lib/mammotion/aliyun/*. */
  authorizationCode?: string;
  /** Account's region/country abbreviation (Mammotion's `domainAbbreviation`), used as the
   *  `countryCode` input to the same legacy Aliyun handshake. */
  countryCode?: string;
}

/** Resolved device ready for use by the driver. */
export interface DeviceContext {
  iotId: string;
  deviceId: string;
  deviceName: string;
  productKey: string;
  /** The deviceName field from the device record (different from the display name). */
  recordDeviceName: string;
  status: number | null;
  deviceType: number | null;
  /** Which cloud device system this mower is bound through, set once at pairing time.
   *  `'mammotion'` (the default/implicit value for devices paired before this field
   *  existed — always treat a missing value as `'mammotion'`, never as an error) uses the
   *  primary JWT/user-server cloud this app was originally built on. `'aliyun_legacy'`
   *  devices are only visible/controllable through the separate Alibaba Cloud IoT Link
   *  Platform system — see docs/ALIYUN_LEGACY_PLAN.md and
   *  docs/ALIYUN_MQTT_TRANSPORT_PLAN.md for why this exists. Deliberately NOT a separate
   *  Homey driver — see that second doc's §1 for the reasoning. */
  transportKind?: 'mammotion' | 'aliyun_legacy';
}
