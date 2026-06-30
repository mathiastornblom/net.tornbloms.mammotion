'use strict';

import https from 'https';
import { createHash, createHmac } from 'crypto';

import {
  OAUTH_APP_KEY,
  OAUTH_APP_SECRET,
  TOKEN_ENDPOINT,
  MAMMOTION_DOMAIN,
  MAMMOTION_API_DOMAIN,
} from '../constants.js';
import { ApiError, AuthError, SessionExpiredError } from '../errors.js';
import type {
  AuthSession,
  DeviceContext,
  DevicePageData,
  DeviceRecord,
  LoginResponse,
  MammotionApiResponse,
  MammotionDevice,
  MqttConnection,
} from './types.js';

/** Performs all Mammotion cloud HTTP calls: login, token refresh, device list, MQTT credentials. */
export class MammotionAuth {

  /** Generates a unique per-session client identifier the Mammotion API expects on every request. */
  private static buildClientId(): string {
    const rand = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('');
    return `${Date.now()}_${rand}_1`;
  }

  /** Computes the HMAC-SHA256 request signature required by the Mammotion OAuth endpoint. */
  private static createOauthSignature(payload: Record<string, string>): string {
    const timestampMs = `${Date.now()}`;
    const payloadJson = JSON.stringify(payload);
    const stringToSign = `${OAUTH_APP_KEY}${timestampMs}${TOKEN_ENDPOINT}${payloadJson}`;
    const md5Secret = createHash('md5').update(OAUTH_APP_SECRET, 'utf8').digest('hex');
    return createHmac('sha256', md5Secret).update(stringToSign, 'utf8').digest('hex');
  }

  /** Decodes the access token's JWT payload to read the regional Aliyun IoT domain claim. */
  private static extractIotDomain(accessToken: string): string {
    const parts = accessToken.split('.');
    if (parts.length < 2) throw new AuthError('Access token is not a valid JWT');
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=',
    );
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { iot?: string };
    if (!claims.iot) throw new AuthError('Access token missing iot domain claim');
    return (claims.iot.startsWith('http') ? claims.iot : `https://${claims.iot}`).replace(/\/$/, '');
  }

  /** Low-level HTTPS POST helper returning parsed JSON. */
  private static request<T>(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      params?: Record<string, string>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const { method = 'GET', headers = {}, params, body } = options;

      let finalUrl = url;
      if (params) {
        const qs = new URLSearchParams(params).toString();
        finalUrl = `${url}?${qs}`;
      }

      const parsedUrl = new URL(finalUrl);
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const reqHeaders: Record<string, string> = {
        'User-Agent': 'okhttp/4.9.3',
        'App-Version': `HomeyApp,${process.env.npm_package_version ?? '1.0.0'}`,
        ...headers,
      };
      if (bodyStr) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: method || 'GET',
          headers: reqHeaders,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch (e) {
              reject(new Error(`Failed to parse response JSON: ${String(e)}`));
            }
          });
        },
      );

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /** Authenticate with email + password, returning a full AuthSession. */
  static async login(email: string, password: string): Promise<AuthSession> {
    const clientId = MammotionAuth.buildClientId();
    const payload = {
      username: email,
      password,
      client_id: OAUTH_APP_KEY,
      grant_type: 'password',
      authType: '0',
    };
    const signature = MammotionAuth.createOauthSignature(payload);

    const resp = await MammotionAuth.request<MammotionApiResponse<LoginResponse>>(
      `${MAMMOTION_DOMAIN}/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Ma-App-Key': OAUTH_APP_KEY,
          'Ma-Signature': signature,
          'Ma-Timestamp': `${Math.floor(Date.now() / 1000)}`,
          'Client-Id': clientId,
          'Client-Type': '1',
        },
        params: payload,
      },
    );

    if (resp.code !== 0 || !resp.data) {
      throw new AuthError(resp.msg || 'Login failed');
    }

    const { access_token, refresh_token, expires_in } = resp.data;
    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
      iotDomain: MammotionAuth.extractIotDomain(access_token),
      userId: resp.data.userInformation?.userId ?? '',
      userAccount: resp.data.userInformation?.userAccount ?? '0',
      clientId,
    };
  }

  /** Refresh an expired access token using the stored refresh token. */
  static async refreshToken(session: AuthSession): Promise<AuthSession> {
    const refreshPayload = {
      client_id: OAUTH_APP_KEY,
      refresh_token: session.refreshToken,
      grant_type: 'refresh_token',
    };
    const signature = MammotionAuth.createOauthSignature(refreshPayload);

    const resp = await MammotionAuth.request<MammotionApiResponse<LoginResponse>>(
      `${MAMMOTION_DOMAIN}/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Ma-App-Key': OAUTH_APP_KEY,
          'Ma-Signature': signature,
          'Ma-Timestamp': `${Math.floor(Date.now() / 1000)}`,
          'Client-Id': session.clientId,
          'Client-Type': '1',
        },
        params: refreshPayload,
      },
    );

    if (resp.code !== 0 || !resp.data) {
      throw new SessionExpiredError();
    }

    const { access_token, refresh_token, expires_in } = resp.data;
    return {
      ...session,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
      iotDomain: MammotionAuth.extractIotDomain(access_token),
    };
  }

  /** Ensure session is valid, refreshing if it expires within 5 minutes. */
  static async ensureValidSession(
    session: AuthSession,
    email: string,
    password: string,
  ): Promise<AuthSession> {
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() < session.expiresAt - fiveMinutes) return session;
    try {
      return await MammotionAuth.refreshToken(session);
    } catch {
      return await MammotionAuth.login(email, password);
    }
  }

  /** Fetch the list of devices from the Mammotion cloud API. */
  static async fetchDevices(session: AuthSession): Promise<MammotionDevice[]> {
    const authHeader = { Authorization: `Bearer ${session.accessToken}`, 'Client-Id': session.clientId, 'Client-Type': '1' };
    const resp = await MammotionAuth.request<MammotionApiResponse<MammotionDevice[]>>(
      `${MAMMOTION_API_DOMAIN}/device-server/v1/device/list`,
      { method: 'GET', headers: authHeader },
    );
    if (resp.code !== 0 || !Array.isArray(resp.data)) {
      throw new ApiError(resp.code, resp.msg ?? 'Failed to fetch device list');
    }
    return resp.data;
  }

  /** Fetch device records including productKey and recordDeviceName needed for MQTT. */
  static async fetchDeviceRecords(session: AuthSession): Promise<DeviceRecord[]> {
    const authHeader = { Authorization: `Bearer ${session.accessToken}`, 'Client-Id': session.clientId, 'Client-Type': '1' };
    const resp = await MammotionAuth.request<MammotionApiResponse<DevicePageData | DeviceRecord[]>>(
      `${session.iotDomain}/v1/user/device/page`,
      {
        method: 'POST',
        headers: authHeader,
        body: { iotId: '', pageNumber: 1, pageSize: 100 },
      },
    );
    if (resp.code !== 0 || !resp.data) {
      throw new ApiError(resp.code, resp.msg ?? 'Failed to fetch device records');
    }
    if (Array.isArray(resp.data)) return resp.data;
    if (Array.isArray((resp.data as DevicePageData).records)) return (resp.data as DevicePageData).records;
    return [];
  }

  /** Fetch JWT-based MQTT connection credentials. */
  static async fetchMqttCredentials(session: AuthSession): Promise<MqttConnection> {
    const authHeader = { Authorization: `Bearer ${session.accessToken}` };
    const resp = await MammotionAuth.request<MammotionApiResponse<MqttConnection>>(
      `${session.iotDomain}/v1/mqtt/auth/jwt`,
      { method: 'POST', headers: authHeader, body: {} },
    );
    if (resp.code !== 0 || !resp.data) {
      throw new ApiError(resp.code, resp.msg ?? 'Failed to fetch MQTT credentials');
    }
    return resp.data;
  }

  /**
   * Resolve a combined device context from device + record, ready for MQTT use.
   * `device` is the owned-devices entry and may be absent for mowers that were
   * shared (not owned) by this account — `record` alone is then authoritative.
   */
  static mergeDeviceContext(device: Partial<MammotionDevice>, record: DeviceRecord): DeviceContext {
    const iotId = device.iotId ?? record.iotId;
    return {
      iotId,
      deviceId: device.deviceId ?? record.deviceId ?? '',
      deviceName: device.deviceName ?? record.deviceName ?? iotId,
      productKey: record.productKey ?? '',
      recordDeviceName: record.deviceName ?? '',
      status: device.status ?? record.status ?? null,
      deviceType: typeof device.deviceType === 'number'
        ? device.deviceType
        : device.deviceType != null ? Number(device.deviceType) : null,
    };
  }
}
