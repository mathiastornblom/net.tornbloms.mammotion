'use strict';

import https from 'https';
import mqtt from 'mqtt';

import type { MqttConnection, AuthSession, DeviceContext } from '../auth/types';
import { decodeMessage, getBytesField, getVarintField } from '../protocol/Codec';
import { MQTT_CONNECT_TIMEOUT_MS, MQTT_RECONNECT_PERIOD_MS, WORK_MODE } from '../constants';

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
}

export type TelemetryCallback = (iotId: string, state: Partial<TelemetryState>) => void;
export type StatusCallback = (iotId: string, online: boolean) => void;

const MQTT_INVOKE_PATH = '/v1/message/send';

/** Wraps the Mammotion JWT-based MQTT connection and provides send / receive APIs. */
export class MqttClient {

  private client: ReturnType<typeof mqtt.connect> | null = null;
  private onTelemetry: TelemetryCallback;
  private onStatus: StatusCallback;
  private log: (msg: string) => void;
  private logError: (msg: string) => void;

  /** Map from `{productKey}/{recordDeviceName}` → iotId */
  private topicToIotId = new Map<string, string>();

  constructor(opts: {
    onTelemetry: TelemetryCallback;
    onStatus: StatusCallback;
    log: (msg: string) => void;
    logError: (msg: string) => void;
  }) {
    this.onTelemetry = opts.onTelemetry;
    this.onStatus = opts.onStatus;
    this.log = opts.log;
    this.logError = opts.logError;
  }

  /** Connect to the MQTT broker and subscribe to device topics. */
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
      reconnectPeriod: MQTT_RECONNECT_PERIOD_MS,
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
    });
  }

  private subscribeDeviceTopics(devices: DeviceContext[]): void {
    const topics: string[] = [];
    for (const d of devices) {
      if (!d.productKey || !d.recordDeviceName) continue;
      const pk = d.productKey;
      const dn = d.recordDeviceName;
      topics.push(
        `/sys/${pk}/${dn}/app/down/thing/status`,
        `/sys/${pk}/${dn}/thing/event/+/post`,
        `/sys/proto/${pk}/${dn}/thing/event/+/post`,
        `/sys/${pk}/${dn}/app/down/thing/properties`,
        `/sys/${pk}/${dn}/app/down/thing/events`,
        `/sys/${pk}/${dn}/app/down/thing/model/down_raw`,
        `/sys/${pk}/${dn}/app/down/_thing/event/notify`,
        `/sys/${pk}/${dn}/thing/event/property/post`,
      );
    }
    for (const topic of topics) {
      this.client?.subscribe(topic, (err: Error | null) => {
        if (err) this.logError(`MQTT subscribe failed (${topic}): ${err.message}`);
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

      if (topic.includes('/thing/event/') || topic.includes('/thing/properties')) {
        this.handleJsonTelemetry(iotId ?? '', json);
      }
    } catch {
      // non-JSON payload on non-proto topic — ignore
    }
  }

  private handleProtobufMessage(iotId: string, payload: Buffer): void {
    try {
      const fields = decodeMessage(payload);
      const telemetry: Partial<TelemetryState> = {};

      // Field 10 = MctlSys, field 11 = MctlNav, field 12 = MctlDriver
      const sysField = getBytesField(fields, 10);
      if (sysField) {
        const sys = decodeMessage(sysField);
        // MctlSys field 1 = toapp_report_cfg_rsp → contains work_tatus (field 2)
        const reportRsp = getBytesField(sys, 1);
        if (reportRsp) {
          const rsp = decodeMessage(reportRsp);
          const workMode = getVarintField(rsp, 2);
          if (workMode !== null) telemetry.workMode = workMode;
          const bat = getVarintField(rsp, 3);
          if (bat !== null) telemetry.batteryPercent = bat;
          const wifiRssi = getVarintField(rsp, 4);
          if (wifiRssi !== null) telemetry.wifiRssi = wifiRssi > 0x7fffffff ? wifiRssi - 0x100000000 : wifiRssi;
          const bleRssi = getVarintField(rsp, 5);
          if (bleRssi !== null) telemetry.bleRssi = bleRssi > 0x7fffffff ? bleRssi - 0x100000000 : bleRssi;
          const gps = getVarintField(rsp, 6);
          if (gps !== null) telemetry.gpsStars = gps;
        }
      }

      const navField = getBytesField(fields, 11);
      if (navField) {
        const nav = decodeMessage(navField);
        // MctlNav field 22 = toapp_work_state
        const workState = getBytesField(nav, 22);
        if (workState) {
          const ws = decodeMessage(workState);
          const area = getVarintField(ws, 1);
          if (area !== null) telemetry.area = area;
          const prog = getVarintField(ws, 5);
          if (prog !== null) telemetry.progress = prog;
          const elapsed = getVarintField(ws, 7);
          if (elapsed !== null) telemetry.elapsedTime = elapsed;
          const left = getVarintField(ws, 8);
          if (left !== null) telemetry.leftTime = left;
        }
      }

      if (Object.keys(telemetry).length > 0 && iotId) {
        this.onTelemetry(iotId, telemetry);
      }
    } catch {
      // malformed protobuf — ignore
    }
  }

  private handleJsonTelemetry(iotId: string, json: Record<string, unknown>): void {
    const params = json?.params as Record<string, unknown>;
    if (!params || !iotId) return;

    const telemetry: Partial<TelemetryState> = {};
    const items = Array.isArray(params) ? params : [params];

    for (const item of items) {
      const rec = item as Record<string, unknown>;
      const identifier = rec.identifier as string | undefined;
      const val = rec.value;
      if (identifier === 'workState' || identifier === 'work_mode') {
        telemetry.workMode = Number(val);
      } else if (identifier === 'battery' || identifier === 'batterypercent') {
        telemetry.batteryPercent = Number(val);
      }
    }

    if (Object.keys(telemetry).length > 0) {
      this.onTelemetry(iotId, telemetry);
    }
  }

  /** Send a base64-encoded protobuf command via the IoT REST invoke endpoint. */
  async sendCommand(
    session: AuthSession,
    context: DeviceContext,
    contentBase64: string,
  ): Promise<string> {
    const body = JSON.stringify({
      iotId: context.iotId,
      identifier: 'device_protobuf_msg_send',
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
