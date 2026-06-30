import Homey from 'homey';

import { BlufiFrameAssembler, buildFrames, resetSendSequence, PACKAGE_TYPE_DATA, SUB_TYPE_CUSTOM_DATA } from './BlufiCodec.js';
import { decodeLubaMsg } from '../protocol/Codec.js';
import { buildBleSyncCommand } from '../commands/LubaCommands.js';
import { BLE_SERVICE_UUID, BLE_LOCAL_NAME_PREFIXES } from '../constants.js';

/** UUIDs verified against pymammotion/bluetooth/const.py */
const UUID_SERVICE = BLE_SERVICE_UUID;
const UUID_WRITE_CHAR = '0000ff01-0000-1000-8000-00805f9b34fb';
const UUID_NOTIFY_CHAR = '0000ff02-0000-1000-8000-00805f9b34fb';

/** Conservative default — pymammotion assumes negotiated 517-byte ATT_MTU; Homey doesn't
 *  expose MTU negotiation, so start at BLE 4.0 default (20 bytes) until verified on device. */
const BLE_CHUNK_SIZE = 20;

/** Reconnect grace period after BLE fails, to avoid hammering the radio. */
const BLE_RECONNECT_DELAY_MS = 15_000;

/** Minimal duck-type of the BLE manager — all BleTransport ever calls on it. */
interface BleManager {
  discover(serviceFilter?: string[]): Promise<Homey.BleAdvertisement[]>;
}

export type BleMessageCallback = (iotId: string, decoded: Record<string, unknown>) => void;
export type BleStatusCallback = (iotId: string, connected: boolean) => void;

/**
 * BLE transport for Mammotion mowers using the Homey BLE API + BluFi framing.
 * Mirrors MqttClient's contract so the same telemetry/command pipeline (Codec.ts)
 * applies without modification. See docs/BLE_PLAN.md for the full analysis and open
 * questions to verify once tested against a real device.
 *
 * ⚠️  Real-device test (2026-06-30, Homey 3s / homey3s, 90+ min runtime): BLE scan
 * never found the mower's advertisement even once, while MQTT ran fine in parallel
 * the whole time. Connect/notify/MTU/BluFi-framing remain unverified — discovery
 * never got that far. See [[protocol-notes]] memory for the full writeup before
 * changing scan logic again.
 */
export class BleTransport {
  private bleManager: BleManager;
  private iotId: string;
  private deviceName: string;
  private onMessage: BleMessageCallback;
  private onStatus: BleStatusCallback;
  private log: (msg: string) => void;
  private logError: (msg: string) => void;

  private peripheral: Homey.BlePeripheral | null = null;
  private writeChar: Homey.BleCharacteristic | null = null;
  private assembler = new BlufiFrameAssembler();
  private seq = { value: -1 };

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: {
    /** Pass `this.homey.ble` from a Device or Driver. */
    bleManager: BleManager;
    iotId: string;
    deviceName: string;
    onMessage: BleMessageCallback;
    onStatus: BleStatusCallback;
    log: (msg: string) => void;
    logError: (msg: string) => void;
  }) {
    this.bleManager = opts.bleManager;
    this.iotId = opts.iotId;
    this.deviceName = opts.deviceName;
    this.onMessage = opts.onMessage;
    this.onStatus = opts.onStatus;
    this.log = opts.log;
    this.logError = opts.logError;
  }

  /** Scan for the mower advertisement then connect, discover, subscribe and sync. */
  async connect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const advertisement = await this.discoverMower();
      if (!advertisement) {
        // Not found is the expected steady state when MQTT is doing the work (or
        // this hub's BLE radio simply can't see the mower) — log it quietly and
        // retry. Reserve logError for failures after a successful scan match.
        this.log(`BLE: device ${this.deviceName} not found in scan`);
        this.scheduleReconnect();
        return;
      }
      this.log(`BLE: found ${advertisement.localName} (RSSI ${advertisement.rssi})`);

      const peripheral = await advertisement.connect();
      this.peripheral = peripheral;

      const [service] = await peripheral.discoverServices([UUID_SERVICE]);
      if (!service) {
        this.logError(`BLE: service ${UUID_SERVICE} not found on ${this.deviceName}`);
        await this.disconnectPeripheral();
        this.scheduleReconnect();
        return;
      }

      const [notifyChar, writeChar] = await Promise.all([
        service.getCharacteristic(UUID_NOTIFY_CHAR),
        service.getCharacteristic(UUID_WRITE_CHAR),
      ]);

      this.writeChar = writeChar;
      this.assembler.reset();
      resetSendSequence();
      this.seq = { value: -1 };

      await notifyChar.subscribeToNotifications((data: Buffer) => this.handleNotification(data));
      this.log('BLE: subscribed to notifications');

      this.onStatus(this.iotId, true);

      // One-shot BLE sync — same as pymammotion's _ble_sync(2) on connect.
      await this.sendBytes(buildBleSyncCommand(2, this.seq));
      this.log('BLE: sent todev_ble_sync(2)');

    } catch (err) {
      this.logError(`BLE: connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.onStatus(this.iotId, false);
      await this.disconnectPeripheral();
      this.scheduleReconnect();
    }
  }

  /** Write raw protobuf bytes (LubaMsg) to the device, applying BluFi framing. */
  async send(payload: Buffer): Promise<void> {
    if (!this.writeChar) throw new Error('BLE not connected');
    await this.sendBytes(payload);
  }

  /** Stop BLE — cancel reconnect, disconnect gracefully. */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.disconnectPeripheral();
  }

  get isConnected(): boolean {
    return this.peripheral?.isConnected ?? false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async discoverMower(): Promise<Homey.BleAdvertisement | null> {
    const ads = await this.bleManager.discover([UUID_SERVICE]);
    this.log(`BLE: scan found ${ads.length} devices with service ${UUID_SERVICE}`);
    return ads.find(
      (ad) => BLE_LOCAL_NAME_PREFIXES.some((prefix) => ad.localName?.startsWith(prefix))
        && ad.localName === this.deviceName,
    ) ?? null;
  }

  private handleNotification(data: Buffer): void {
    const result = this.assembler.push(data);
    if (result.kind === 'fragment') return;
    if (result.kind === 'duplicate') return;
    if (result.kind === 'error') {
      this.logError(`BLE: frame parse error: ${result.reason}`);
      return;
    }
    if (result.packageType !== PACKAGE_TYPE_DATA || result.subType !== SUB_TYPE_CUSTOM_DATA) return;

    let decoded: Record<string, unknown>;
    try {
      decoded = decodeLubaMsg(result.data);
    } catch (err) {
      this.logError(`BLE: protobuf decode failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.onMessage(this.iotId, decoded);

    // Detect unexpected disconnects after receive (Homey BlePeripheral has no documented
    // 'disconnect' event — polling isConnected is the safe fallback).
    if (this.peripheral && !this.peripheral.isConnected) {
      this.log('BLE: peripheral disconnected (detected after receive)');
      this.handleDisconnect();
    }
  }

  private async sendBytes(bytes: Buffer): Promise<void> {
    if (!this.writeChar) throw new Error('BLE write characteristic not available');
    const frames = buildFrames(bytes, { chunkSize: BLE_CHUNK_SIZE });
    for (const frame of frames) {
      await this.writeChar.write(frame);
      // Small delay between fragments to avoid overrunning the device buffer
      // (pymammotion sleeps 10ms between fragments in post_contains_data).
      if (frames.length > 1) await new Promise<void>((res) => setTimeout(res, 10));
    }
  }

  private handleDisconnect(): void {
    this.writeChar = null;
    this.onStatus(this.iotId, false);
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.log(`BLE: scheduling reconnect in ${BLE_RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, BLE_RECONNECT_DELAY_MS);
  }

  private async disconnectPeripheral(): Promise<void> {
    const p = this.peripheral;
    this.peripheral = null;
    this.writeChar = null;
    if (p && p.isConnected) {
      await p.disconnect().catch(() => { /* ignore errors on cleanup */ });
    }
  }
}
