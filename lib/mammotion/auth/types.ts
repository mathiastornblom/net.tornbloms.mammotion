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
}
