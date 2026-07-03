'use strict';

import { createHmac } from 'crypto';
import mqtt from 'mqtt';

import { decodeLubaMsg } from '../protocol/Codec.js';

/**
 * Config for the ONE shared Aliyun IoT MQTT connection for an account — NOT per-device.
 * All fields come from the account-level identity registered via `aepHandle()` in
 * AliyunLegacyProbe.ts (`AliyunLegacyCredentials`), not from any individual mower.
 * See docs/ALIYUN_MQTT_TRANSPORT_PLAN.md section 3's "CORRECTION" for why this is
 * account-scoped rather than device-scoped.
 */
export interface AliyunMqttConfig {
  /** Region gateway domain, e.g. from AliyunLegacyCredentials.apiGatewayEndpoint. */
  apiGatewayEndpoint: string;
  /** Aliyun region id (e.g. "cn-shanghai") — used to build the broker hostname. */
  regionId: string;
  /** Account's own AEP-registered device secret, used to HMAC-sign MQTT credentials. */
  deviceSecret: string;
  /** Account's own AEP-registered productKey (NOT any individual mower's). */
  productKey: string;
  /** Account's own AEP-registered deviceName (NOT any individual mower's). */
  deviceName: string;
  /** Short-lived session token, sent in the bind message and re-read on every (re)connect. */
  iotToken: string;
}

/** Fired with a decoded LubaMsg once its target device is identified via the envelope's `params.iotId`. */
export type AliyunMessageCallback = (decoded: Record<string, unknown>) => void;
/** Fired when a registered device's reported online/offline status changes. */
export type AliyunStatusCallback = (online: boolean) => void;

const ALIYUN_MQTT_PORT = 8883;
const ALIYUN_MQTT_KEEPALIVE_SEC = 60;

/** Initial reconnect delay after the Aliyun MQTT connection drops. Doubles on each
 *  consecutive failure, capped at ALIYUN_RECONNECT_MAX_MS — mirrors device.ts's
 *  scheduleMqttReconnect()/BleTransport's backoff shape. */
const ALIYUN_RECONNECT_BASE_MS = 5_000;
const ALIYUN_RECONNECT_MAX_MS = 5 * 60_000;

interface RegisteredDevice {
  onMessage: AliyunMessageCallback;
  onStatus: AliyunStatusCallback;
}

/**
 * Derives Aliyun IoT MQTT connection credentials from account identity + a timestamp.
 * Pure and side-effect-free (timestamp is an explicit parameter, not read from the clock
 * internally) so it's independently unit-testable — see scripts/aliyun-mqtt-credentials.test.mjs.
 *
 * Ported from `AliyunMQTTTransport._build_credentials` (pymammotion
 * `pymammotion/transport/aliyun_mqtt.py`, verified 2026-07-03): HMAC-SHA1 hex digest of
 * `clientId{base}deviceName{name}productKey{key}timestamp{ts}`, keyed by deviceSecret.
 * `clientIdBase` defaults to `${productKey}&${deviceName}` — this app has no analog of
 * pymammotion's optional `client_id_base` override parameter, so it's always derived.
 */
export function deriveAliyunMqttCredentials(
  config: Pick<AliyunMqttConfig, 'productKey' | 'deviceName' | 'deviceSecret'>,
  timestampSeconds: number,
): { clientId: string; username: string; password: string } {
  const { productKey, deviceName, deviceSecret } = config;
  const clientIdBase = `${productKey}&${deviceName}`;
  const timestamp = String(timestampSeconds);
  const clientId = `${clientIdBase}|securemode=2,signmethod=hmacsha1,ext=1,_ss=1,timestamp=${timestamp}|`;
  const signContent = `clientId${clientIdBase}deviceName${deviceName}productKey${productKey}timestamp${timestamp}`;
  const password = createHmac('sha1', deviceSecret).update(signContent, 'utf8').digest('hex');
  const username = `${deviceName}&${productKey}`;
  return { clientId, username, password };
}

/**
 * Shared Aliyun IoT MQTT transport for legacy-bound devices — ONE connection per
 * Mammotion account (owned by LubaDriver), registering every 'aliyun_legacy'-flagged
 * device on that account via `registerDevice()`. This mirrors pymammotion's
 * `AliyunMQTTTransport` + `client.py`'s `_setup_aliyun_transport`/`_register_aliyun_device`
 * exactly: unlike the per-device Mammotion MQTT topic model, Aliyun's broker fans all of
 * an account's bound-device events into this one registered identity's fixed 9-topic set —
 * incoming messages are disambiguated by the `params.iotId` field inside the JSON envelope
 * itself, not by topic path or by any per-device subscription
 * (`pymammotion/transport/aliyun_mqtt.py::_unwrap_envelope`, confirmed 2026-07-03: `iot_id
 * = parsed.get("params", {}).get("iotId", "")`, read unconditionally before either
 * envelope-shape branch, and `client.py::_register_aliyun_device` never calls anything like
 * `transport.register_device()` the way the Mammotion-transport equivalent does).
 *
 * Command SENDING does not go through this class at all — pymammotion's `send()`
 * delegates to `CloudIOTGateway.send_cloud_command` (the CA-signature REST invoke,
 * `sendAliyunCloudCommand` in gateway.ts, built by a parallel effort). This transport is
 * receive-only (telemetry/status) plus one outbound bind-handshake publish per connection.
 *
 * Credentials are re-derived on every (re)connect — never reused — because the HMAC-SHA1
 * password embeds a `timestamp` field that Aliyun's broker rejects once stale, same
 * reasoning (stronger here) that already justifies MqttClient.ts disabling mqtt.js's
 * built-in reconnect (see MqttClient.ts's `connect()` doc comment).
 */
export class AliyunMqttTransport {

  private config: AliyunMqttConfig;
  private log: (msg: string) => void;
  private logError: (msg: string) => void;

  private client: ReturnType<typeof mqtt.connect> | null = null;
  private devices = new Map<string, RegisteredDevice>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(opts: {
    config: AliyunMqttConfig;
    log: (msg: string) => void;
    logError: (msg: string) => void;
  }) {
    this.config = opts.config;
    this.log = opts.log;
    this.logError = opts.logError;
  }

  /** Registers a device to receive routed messages/status on this shared connection.
   *  Safe to call before or after connect(); safe to call multiple times (multiple mowers). */
  registerDevice(iotId: string, onMessage: AliyunMessageCallback, onStatus: AliyunStatusCallback): void {
    this.devices.set(iotId, { onMessage, onStatus });
  }

  /** Removes a device from routing — e.g. on Homey device deletion or transport-kind change. */
  unregisterDevice(iotId: string): void {
    this.devices.delete(iotId);
  }

  /**
   * Connect to the Aliyun IoT MQTT broker, subscribe the fixed 9-topic set, and send the
   * account bind handshake. Aliyun's HMAC-SHA1 password embeds a timestamp, so mqtt.js's
   * built-in auto-reconnect is disabled (reconnectPeriod: 0) — on close, credentials are
   * freshly re-derived and connect() is called again, same pattern as MqttClient.ts.
   */
  connect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }

    const { clientId, username, password } = this.buildCredentials();
    const host = `${this.config.productKey}.iot-as-mqtt.${this.config.regionId}.aliyuncs.com`;
    const brokerUrl = `mqtts://${host}:${ALIYUN_MQTT_PORT}`;

    this.client = mqtt.connect(brokerUrl, {
      clientId,
      username,
      password,
      reconnectPeriod: 0,
      connectTimeout: ALIYUN_RECONNECT_BASE_MS * 2,
      keepalive: ALIYUN_MQTT_KEEPALIVE_SEC,
      protocolVersion: 4,
      clean: true,
    });

    this.client.on('connect', () => {
      this.log('Aliyun MQTT connected');
      this.consecutiveFailures = 0;
      this.subscribeTopics();
      this.publishBindMessage();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err: Error) => {
      this.logError(`Aliyun MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.log('Aliyun MQTT connection closed');
      this.notifyAllOffline();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  /** Tears down the MQTT connection and cancels any pending reconnect. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
  }

  /** Whether the MQTT client currently has an open broker connection. */
  get isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /** Derives a fresh (clientId, username, password) triple stamped with the current time —
   *  see the standalone deriveAliyunMqttCredentials() for the underlying pure algorithm. */
  private buildCredentials(): { clientId: string; username: string; password: string } {
    return deriveAliyunMqttCredentials(this.config, Math.floor(Date.now() / 1000));
  }

  /** Subscribes the fixed 9-topic set pymammotion's `_default_subscribe_topics` uses,
   *  scoped to the account's own AEP-registered productKey/deviceName. */
  private subscribeTopics(): void {
    const base = `/sys/${this.config.productKey}/${this.config.deviceName}`;
    const topics = [
      `${base}/app/down/account/bind_reply`,
      `${base}/app/down/thing/event/property/post_reply`,
      `${base}/app/down/thing/wifi/status/notify`,
      `${base}/app/down/thing/wifi/connect/event/notify`,
      `${base}/app/down/_thing/event/notify`,
      `${base}/app/down/thing/events`,
      `${base}/app/down/thing/status`,
      `${base}/app/down/thing/properties`,
      `${base}/app/down/thing/model/down_raw`,
    ];
    for (const topic of topics) {
      this.client?.subscribe(topic, { qos: 1 }, (err: Error | null) => {
        if (err) this.logError(`Aliyun MQTT subscribe failed (${topic}): ${err.message}`);
        else this.log(`Aliyun MQTT subscribed: ${topic}`);
      });
    }
  }

  /** Publishes the account bind handshake — required once per connection so the broker
   *  starts forwarding this account's device events to this client (pymammotion's `_run`,
   *  publishing to `.../app/up/account/bind`). */
  private publishBindMessage(): void {
    const topic = `/sys/${this.config.productKey}/${this.config.deviceName}/app/up/account/bind`;
    const username = `${this.config.deviceName}&${this.config.productKey}`;
    const body = JSON.stringify({
      id: 'msgid1',
      version: '1.0',
      request: { clientId: username },
      params: { iotToken: this.config.iotToken },
    });
    this.client?.publish(topic, body, { qos: 1 }, (err) => {
      if (err) this.logError(`Aliyun MQTT bind publish failed: ${err.message}`);
      else this.log('Aliyun MQTT bind message sent');
    });
  }

  /** Routes an incoming message by topic suffix, mirroring pymammotion's `_run` dispatch. */
  private handleMessage(topic: string, payload: Buffer): void {
    if (topic.endsWith('/account/bind_reply')) {
      this.handleBindReply(payload);
      return;
    }
    if (topic.endsWith('/thing/status')) {
      this.handleStatusMessage(payload);
      return;
    }
    // /thing/events, /thing/properties, and all remaining topics carry the same
    // {params: {iotId, ...}} envelope shape and are routed identically here — this app
    // only cares about the protobuf payload (device_protobuf_msg_event), not pymammotion's
    // separately-typed ThingEventMessage/ThingPropertiesMessage handling.
    this.handleEnvelopeMessage(payload);
  }

  /** Logs bind failures (e.g. code 2043 "check iotToken failed") — does not throw, since a
   *  rejected bind still leaves the connection open for the caller's own reconnect logic
   *  to eventually notice via silence/no telemetry. */
  private handleBindReply(payload: Buffer): void {
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as { code?: number };
      if (parsed.code !== undefined && parsed.code !== 200) {
        this.logError(`Aliyun MQTT bind rejected (code=${parsed.code})`);
      }
    } catch {
      // non-JSON bind_reply — ignore
    }
  }

  /** Parses a thing/status message and forwards online/offline to the target device's
   *  onStatus callback, keyed by params.iotId. */
  private handleStatusMessage(payload: Buffer): void {
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as {
        params?: { iotId?: string; status?: string; value?: number };
      };
      const iotId = parsed.params?.iotId;
      if (!iotId) return;
      const device = this.devices.get(iotId);
      if (!device) return;
      const online = parsed.params?.status === 'online' || parsed.params?.value === 1;
      device.onStatus(online);
    } catch {
      // non-JSON status payload — ignore
    }
  }

  /**
   * Unwraps a JSON envelope and routes the decoded LubaMsg to the target device, keyed by
   * `params.iotId` — the field pymammotion's `_unwrap_envelope` reads unconditionally
   * before attempting either envelope shape (confirmed against source, see class doc).
   * Two content shapes are attempted, matching `_unwrap_envelope` exactly:
   *   1. Aliyun `thing.events` shape: `params.value.content` (base64).
   *   2. Mammotion direct-MQTT shape: `params.content` (base64) — same shape
   *      MqttClient.ts's `extractBase64Content` already handles.
   */
  private handleEnvelopeMessage(payload: Buffer): void {
    let parsed: { params?: { iotId?: string; content?: string; value?: { content?: string } } };
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      return; // non-JSON payload — ignore
    }

    const iotId = parsed.params?.iotId;
    if (!iotId) return;
    const device = this.devices.get(iotId);
    if (!device) return;

    const content = parsed.params?.value?.content ?? parsed.params?.content;
    if (!content) return;

    let decoded: Record<string, unknown>;
    try {
      decoded = decodeLubaMsg(Buffer.from(content, 'base64'));
    } catch (err) {
      this.logError(`Aliyun MQTT protobuf decode failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    device.onMessage(decoded);
  }

  /** Notifies every registered device that the shared connection is down. */
  private notifyAllOffline(): void {
    for (const device of this.devices.values()) {
      device.onStatus(false);
    }
  }

  /** Schedules the next connect() attempt with exponential backoff based on consecutive
   *  failures — same shape as BleTransport's/device.ts's scheduleMqttReconnect(). */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.consecutiveFailures++;
    const delay = Math.min(ALIYUN_RECONNECT_BASE_MS * (2 ** this.consecutiveFailures), ALIYUN_RECONNECT_MAX_MS);
    this.log(`Aliyun MQTT: scheduling reconnect in ${Math.round(delay / 1000)}s (failure #${this.consecutiveFailures})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
