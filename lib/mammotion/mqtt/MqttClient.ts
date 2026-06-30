'use strict';

import https from 'https';
import mqtt from 'mqtt';

import type { MqttConnection, AuthSession, DeviceContext } from '../auth/types.js';
import { decodeLubaMsg } from '../protocol/Codec.js';
import { extractTelemetry } from '../protocol/TelemetryParser.js';
import { MQTT_CONNECT_TIMEOUT_MS } from '../constants.js';

export interface TelemetryState {
  workMode: number | null;
  batteryPercent: number | null;
  wifiRssi: number | null;
  bleRssi: number | null;
  gpsStars: number | null;
  area: number | null;
  mowingSpeed: number | null;
  progress: number | null;
  elapsedTime: number | null;
  leftTime: number | null;
  bladeHeight: number | null;
  posLevel: number | null;
  latitude: number | null;
  longitude: number | null;
  errorCode: number | null;
  // maintain report (RIT_MAINTAIN)
  batteryCycles: number | null;
  bladeUsedTime: number | null;
}

export type TelemetryCallback = (iotId: string, state: Partial<TelemetryState>) => void;
export type StatusCallback = (iotId: string, online: boolean) => void;

const MQTT_INVOKE_PATH = '/v1/mqtt/rpc/thing/service/invoke';

/** Random 21-digit request id, as sent by the official app on every invoke call. */
function buildRequestId(): string {
  return Array.from({ length: 21 }, () => Math.floor(Math.random() * 10)).join('');
}

/** Wraps the Mammotion JWT-based MQTT connection and provides send / receive APIs. */
export class MqttClient {

  private client: ReturnType<typeof mqtt.connect> | null = null;
  private onTelemetry: TelemetryCallback;
  private onStatus: StatusCallback;
  private onNotification: (iotId: string, identifier: string) => void;
  private onRawMessage?: (iotId: string, msg: Record<string, unknown>) => void;
  private onClose: () => void;
  private log: (msg: string) => void;
  private logError: (msg: string) => void;

  /** Map from `{productKey}/{recordDeviceName}` → iotId */
  private topicToIotId = new Map<string, string>();

  constructor(opts: {
    onTelemetry: TelemetryCallback;
    onStatus: StatusCallback;
    /** Called for non-telemetry thing/event identifiers (device wants the app to
     *  react) — the caller re-arms the report-config subscription. */
    onNotification: (iotId: string, identifier: string) => void;
    /** Called for every decoded LubaMsg (telemetry or not) — used for on-demand
     *  reads (e.g. schedule) that aren't part of the periodic report stream. */
    onRawMessage?: (iotId: string, msg: Record<string, unknown>) => void;
    /** Called when the broker drops the connection. The JWT is single-use for
     *  reconnects, so the caller must fetch fresh credentials and call connect() again. */
    onClose: () => void;
    log: (msg: string) => void;
    logError: (msg: string) => void;
  }) {
    this.onTelemetry = opts.onTelemetry;
    this.onStatus = opts.onStatus;
    this.onNotification = opts.onNotification;
    this.onRawMessage = opts.onRawMessage;
    this.onClose = opts.onClose;
    this.log = opts.log;
    this.logError = opts.logError;
  }

  /**
   * Connect to the MQTT broker and subscribe to device topics.
   * Aliyun's broker rejects reused JWT credentials on reconnect, so mqtt.js's
   * built-in auto-reconnect is disabled — the caller must refetch credentials
   * (via onClose) and call connect() again with a fresh MqttConnection.
   */
  connect(mqttAuth: MqttConnection, devices: DeviceContext[]): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }

    this.topicToIotId.clear();
    for (const d of devices) {
      if (d.productKey && d.recordDeviceName) {
        this.topicToIotId.set(`${d.productKey}/${d.recordDeviceName}`, d.iotId);
      }
    }

    const brokerUrl = mqttAuth.host.includes('://') ? mqttAuth.host : `mqtts://${mqttAuth.host}`;

    this.client = mqtt.connect(brokerUrl, {
      clientId: mqttAuth.clientId,
      username: mqttAuth.username,
      password: mqttAuth.jwt,
      reconnectPeriod: 0,
      connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
      protocolVersion: 4,
      clean: true,
    });

    this.client.on('connect', () => {
      this.log('MQTT connected');
      this.subscribeDeviceTopics(devices);
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err: Error) => {
      this.logError(`MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.log('MQTT connection closed');
      this.onClose();
    });
  }

  /**
   * Subscribes to exactly the topics pymammotion's JWT-based transport uses.
   * Extra topic guesses (e.g. `app/down/thing/properties`) are not authorized
   * by this account's ACL — Aliyun's broker closes the whole connection (not
   * just the one subscription) when an unauthorized topic is requested.
   */
  private subscribeDeviceTopics(devices: DeviceContext[]): void {
    const topics: string[] = [];
    for (const d of devices) {
      if (!d.productKey || !d.recordDeviceName) continue;
      const pk = d.productKey;
      const dn = d.recordDeviceName;
      topics.push(
        `/sys/${pk}/${dn}/thing/event/+/post`,
        `/sys/proto/${pk}/${dn}/thing/event/+/post`,
        `/sys/${pk}/${dn}/app/down/thing/status`,
      );
    }
    for (const topic of topics) {
      this.client?.subscribe(topic, (err: Error | null) => {
        if (err) this.logError(`MQTT subscribe failed (${topic}): ${err.message}`);
        else this.log(`MQTT subscribed: ${topic}`);
      });
    }
  }

  private handleMessage(topic: string, payload: Buffer): void {
    const parts = topic.split('/');
    if (parts.length < 5) return;

    const isProto = parts[1] === 'sys' && parts[2] === 'proto';
    const productKey = isProto ? parts[3] : parts[2];
    const recordDeviceName = isProto ? parts[4] : parts[3];
    const iotId = this.topicToIotId.get(`${productKey}/${recordDeviceName}`);

    const isRawProto = isProto || topic.includes('/down_raw');

    if (isRawProto) {
      this.handleProtobufMessage(iotId ?? '', payload);
      return;
    }

    try {
      const json = JSON.parse(payload.toString('utf8'));

      if (topic.includes('/thing/status')) {
        const online = json?.params?.status === 'online' || json?.params?.value === 1;
        if (iotId) this.onStatus(iotId, online);
        return;
      }

      if (topic.includes('/thing/event/')) {
        // Topic shape: /sys/{pk}/{dn}/thing/event/{identifier}/post
        const identifier = parts[parts.length - 2];
        if (identifier === 'device_protobuf_msg_event') {
          const content = this.extractBase64Content(json);
          if (content && iotId) {
            this.handleProtobufMessage(iotId, Buffer.from(content, 'base64'));
          }
          return;
        }
        // Any other identifier (device_biz_req_event, device_config_req_event,
        // notifications…) means the device wants the app to react — re-arm the
        // report-config subscription so telemetry keeps flowing.
        if (iotId) this.onNotification(iotId, identifier);
      }
    } catch {
      // non-JSON payload on non-proto topic — ignore
    }
  }

  /** Unwraps the `{params: {content}}` or `{params: {value: {content}}}` envelope. */
  private extractBase64Content(json: unknown): string | null {
    const params = (json as Record<string, unknown> | undefined)?.params as Record<string, unknown> | undefined;
    if (!params) return null;
    if (typeof params.content === 'string') return params.content;
    const value = params.value as Record<string, unknown> | undefined;
    if (value && typeof value.content === 'string') return value.content;
    return null;
  }

  /** Decode a LubaMsg protobuf and forward telemetry via extractTelemetry (TelemetryParser.ts). */
  private handleProtobufMessage(iotId: string, payload: Buffer): void {
    if (!iotId) return;
    let msg: Record<string, unknown>;
    try {
      msg = decodeLubaMsg(payload);
    } catch (err) {
      this.logError(`protobuf decode failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const telemetry = extractTelemetry(msg);
    if (telemetry && Object.keys(telemetry).length > 0) {
      this.onTelemetry(iotId, telemetry);
    }
    this.onRawMessage?.(iotId, msg);
  }

  /** Send a base64-encoded protobuf command via the IoT REST invoke endpoint. */
  async sendCommand(
    session: AuthSession,
    context: DeviceContext,
    contentBase64: string,
  ): Promise<string> {
    // deviceName/productKey are sent empty (matching pymammotion's mqtt_invoke) —
    // only iotId is used for routing.
    const body = JSON.stringify({
      iotId: context.iotId,
      deviceName: '',
      productKey: '',
      identifier: 'device_protobuf_sync_service',
      args: { content: contentBase64 },
    });

    return new Promise((resolve, reject) => {
      const url = new URL(`${session.iotDomain}${MQTT_INVOKE_PATH}`);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'User-Agent': 'okhttp/4.9.3',
            'Client-Id': session.clientId,
            'Client-Type': '1',
            'Request-Id': buildRequestId(),
            'Accept-Language': 'en-US',
            'L-T-Z': `${Date.now()}/0/0`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
  }

  get isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
