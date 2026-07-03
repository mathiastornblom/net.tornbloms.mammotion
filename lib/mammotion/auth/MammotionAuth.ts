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
  DeviceRecordsResult,
  LoginResponse,
  MammotionApiResponse,
  MammotionDevice,
  MqttConnection,
  ShareRecord,
  ShareRecordsPage,
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
      authorizationCode: resp.data.authorization_code,
      countryCode: resp.data.userInformation?.domainAbbreviation,
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

  /**
   * Fetch device records including productKey and recordDeviceName needed for MQTT.
   * Returns the raw `total`/`msg` alongside the parsed records — an account that shows
   * `records=0` with `total=0` genuinely has no devices server-side (a sharing/acceptance
   * problem upstream of this app); `records=0` with `total>0` would instead point to a
   * pagination or parsing bug in this call. See [[project-overview]] pairing troubleshooting.
   */
  static async fetchDeviceRecords(session: AuthSession): Promise<DeviceRecordsResult> {
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
    const msg = resp.msg ?? '';
    if (Array.isArray(resp.data)) return { records: resp.data, total: null, msg };
    if (Array.isArray((resp.data as DevicePageData).records)) {
      const page = resp.data as DevicePageData;
      return { records: page.records, total: page.total ?? null, msg };
    }
    return { records: [], total: null, msg };
  }

  /**
   * Fetch pending device-sharing invitations for this account (statusList -1 = pending only).
   * Deliberately NOT sending Client-Id/Client-Type here — pymammotion's `_headers` base
   * (User-Agent + App-Version only) is used as-is for this endpoint and `confirmShare`;
   * only `get_user_device_page`/`get_user_device_list` add Client-Id/Client-Type. Sending
   * them anyway on a v2.3.3 attempt did not surface any pending records for a confirmed
   * two-mower account, so this mismatch is the leading suspect — see [[architecture-decisions]] #14.
   */
  static async fetchPendingShares(session: AuthSession): Promise<ShareRecord[]> {
    const authHeader = { Authorization: `Bearer ${session.accessToken}` };
    const resp = await MammotionAuth.request<MammotionApiResponse<ShareRecordsPage>>(
      `${MAMMOTION_API_DOMAIN}/user-server/v1/share/device/page`,
      {
        method: 'POST',
        headers: authHeader,
        body: { iotId: '', owned: 0, pageNumber: 1, pageSize: 200, statusList: [-1] },
      },
    );
    if (resp.code !== 0 || !resp.data || !Array.isArray(resp.data.records)) return [];
    return resp.data.records;
  }

  /** Accept (or reject) one batch of pending share invitations. See fetchPendingShares for why
   *  Client-Id/Client-Type are deliberately omitted here, matching pymammotion. */
  static async confirmShare(session: AuthSession, batchId: string, recordIds: string[], agree: 0 | 1 = 1): Promise<void> {
    const authHeader = { Authorization: `Bearer ${session.accessToken}` };
    await MammotionAuth.request<MammotionApiResponse<unknown>>(
      `${MAMMOTION_API_DOMAIN}/user-server/v1/share/device/confirm`,
      {
        method: 'POST',
        headers: authHeader,
        body: { agree, batchId, recordIds: recordIds.map(Number) },
      },
    );
  }

  /**
   * Auto-accepts any pending device-share invitations for this account, mirroring what
   * pymammotion's `login_and_initiate_cloud` does on every login. The mobile app's own
   * "Accept" UI is supposed to finalize this server-side, but our headless pairing flow
   * has no equivalent step — calling this before fetching the device list closes that gap
   * regardless of whether the mobile-app acceptance actually completed. Best-effort: a
   * failure here must not block pairing, since the subsequent device-list fetch will just
   * come up empty (and the existing "no devices found" messaging still applies) if this
   * doesn't help.
   *
   * Returns diagnostic counts, not just the accepted count: `found=0` for an account with
   * mowers confirmed visible in the Mammotion mobile app points strongly at the OTHER,
   * legacy Aliyun IoT sharing system (`/uc/getShareNoticeList` + `/uc/confirmShare`,
   * signed Aliyun API calls — not this REST endpoint) being the actual gate, which this
   * app does not implement. See [[architecture-decisions]] #14.
   */
  static async acceptPendingShares(session: AuthSession): Promise<{ found: number; accepted: number }> {
    const pending = await MammotionAuth.fetchPendingShares(session).catch(() => []);
    const receiverPending = pending.filter((r) => r.isReceiver === 1 && r.status === -1);
    const recordIdsByBatch = new Map<string, string[]>();
    for (const record of receiverPending) {
      const ids = recordIdsByBatch.get(record.batchId) ?? [];
      ids.push(record.recordId);
      recordIdsByBatch.set(record.batchId, ids);
    }
    for (const [batchId, recordIds] of recordIdsByBatch) {
      await MammotionAuth.confirmShare(session, batchId, recordIds).catch(() => {});
    }
    return { found: pending.length, accepted: receiverPending.length };
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
