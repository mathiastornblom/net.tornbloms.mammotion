'use strict';

import https from 'https';
import mqtt from 'mqtt';

import type { MqttConnection, AuthSession, DeviceContext } from '../auth/types.js';
import { decodeLubaMsg } from '../protocol/Codec.js';
import { extractTelemetry } from '../protocol/TelemetryParser.js';
import { MQTT_CONNECT_TIMEOUT_MS } from '../constants.js';
import { DeviceOfflineError, MqttCommandError } from '../errors.js';

/** Mammotion's own invoke-response code for "the mower is offline" — confirmed via a
 *  real user's diagnostic report (2026-07-03): `{"code":50104,"msg":"The device is
 *  offline"}`. Matches pymammotion's http.py `mqtt_invoke` convention of code=0 meaning
 *  success and any other code carrying a specific meaning in `msg`. */
const MQTT_DEVICE_OFFLINE_CODE = 50104;

/** Decoded mower telemetry fields, as extracted from a LubaMsg report by TelemetryParser. */
export interface TelemetryState {
  workMode: number | null;
  /** rpt_dev_status.charge_state — nonzero while actually drawing charge current. Needed
   *  alongside workMode to detect "docked": Mammotion-HA's own state logic (lawn_mower.py)
   *  never maps MODE_CHARGING(15) to its DOCKED activity at all — in practice, a mower
   *  sitting in its dock reports workMode=MODE_READY(11) with chargeState nonzero, not 15.
   *  Ignoring this field left the docked/charging status silently stuck (real user report,
   *  2026-07-05). */
  chargeState: number | null;
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
  /** MctlSys.toapp_err_code.errorCode (see ErrorCodeParser.ts) — a device-pushed fault
   *  code, distinct from the periodic report fields above. Diagnostic only for now: the
   *  numeric code_no → fault meaning table (e.g. wheel-lift/emergency-stop) isn't ported
   *  yet, logged so a real fault event's raw value can be collected first. */
  errorCode: number | null;
  // maintain report (RIT_MAINTAIN)
  batteryCycles: number | null;
  bladeUsedTime: number | null;
  /** Raw rpt_dev_status.headlamp_status wire value — diagnostic only, not yet mapped to a
   *  capability. Encoding (on/off vs. a bitmask for headlamp + side LED) is unverified
   *  since Mammotion-HA never reads this field either; logged so real values can be
   *  collected before implementing. See docs/ROADMAP.md. */
  headlampStatusRaw: number | null;
  /** Raw rpt_dev_status.sensor_status wire value — kept alongside the decoded
   *  bumperState/bladeActive fields below since sensor_status also carries four
   *  ultrasonic-sensor sub-fields (bits 12-23) this app doesn't decode yet. See
   *  TelemetryParser.ts. */
  sensorStatusRaw: number | null;
  /** Decoded from sensorStatusRaw bits 0-2 — see TelemetryParser.ts's decodeBumperState(),
   *  confirmed against pymammotion's own bumper_state property. */
  bumperState: 'ok' | 'warning' | 'error' | null;
  /** Decoded from sensorStatusRaw bits 9-11 — see TelemetryParser.ts's decodeBladeActive(),
   *  confirmed against pymammotion's own blade_state property. True while the cutting blade
   *  motor is spinning. */
  bladeActive: boolean | null;
  /** Raw rpt_dev_status.self_check_status wire value — diagnostic only. Unlike
   *  sensorStatusRaw, this field has no interpretation anywhere in Mammotion-HA/pymammotion
   *  at all, so it stays raw pending a real diagnostic capture giving it empirical meaning.
   *  See docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md. */
  selfCheckStatusRaw: number | null;
}

/** Fired with the changed telemetry fields whenever a report is decoded. */
export type TelemetryCallback = (iotId: string, state: Partial<TelemetryState>) => void;
/** Fired when a device's reported online/offline status changes. */
export type StatusCallback = (iotId: string, online: boolean) => void;

const MQTT_INVOKE_PATH = '/v1/mqtt/rpc/thing/service/invoke';

/** Random 21-digit request id, as sent by the official app on every invoke call. */
function buildRequestId(): string {
  return Array.from({ length: 21 }, () => Math.floor(Math.random() * 10)).join('');
}

/** Pure response-inspection step of sendCommand, split out for independent unit testing
 *  (mirrors how buildInvokeParams/deriveAliyunMqttCredentials are made testable elsewhere
 *  in this codebase — no network I/O here). Resolves with `raw` unchanged on success or a
 *  codeless/non-JSON response (treated as opaque success, matching this method's
 *  pre-existing behavior for response shapes not otherwise seen in practice); throws
 *  DeviceOfflineError or MqttCommandError on a non-zero `code`. */
export function checkInvokeResponse(raw: string, deviceLabel: string): string {
  let parsed: { code?: number; msg?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed.code === undefined || parsed.code === 0) return raw;
  if (parsed.code === MQTT_DEVICE_OFFLINE_CODE) {
    throw new DeviceOfflineError(deviceLabel);
  }
  throw new MqttCommandError(parsed.code, parsed.msg ?? `MQTT invoke returned code ${parsed.code}`);
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
    this.teardownClient();

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

  /** Routes an incoming MQTT message to status, protobuf, or notification handling by topic shape. */
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

  /** Send a base64-encoded protobuf command via the IoT REST invoke endpoint. Resolves with
   *  the raw response body on success (`code: 0`) — throws DeviceOfflineError if the mower
   *  itself reports it's offline (`code: 50104`), or MqttCommandError for any other
   *  non-zero code. A non-JSON or codeless response is treated as opaque success, matching
   *  this method's pre-existing behavior for response shapes not yet seen in practice. */
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

    const raw = await new Promise<string>((resolve, reject) => {
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

    return checkInvokeResponse(raw, context.recordDeviceName || context.iotId);
  }

  /** Tears down the MQTT connection and removes all listeners. */
  disconnect(): void {
    this.teardownClient();
  }

  /** Whether the MQTT client currently has an open broker connection. */
  get isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Ends and discards the current client, if any.
   * A no-op 'error' listener is re-attached before removeAllListeners()'s
   * effect would otherwise leave the client with zero 'error' listeners:
   * mqtt.js can emit 'error' (e.g. a pending connack-timeout timer) on the
   * old client instance after end(true) is called, and Node's EventEmitter
   * throws synchronously when 'error' is emitted with no listeners attached.
   */
  private teardownClient(): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.end(true);
      this.client = null;
    }
  }
}
