import Homey from 'homey';

import { BlufiFrameAssembler, buildFrames, resetSendSequence, PACKAGE_TYPE_DATA, SUB_TYPE_CUSTOM_DATA } from './BlufiCodec.js';
import { decodeLubaMsg } from '../protocol/Codec.js';
import { buildBleSyncCommand } from '../commands/LubaCommands.js';
import { BLE_SERVICE_UUID, BLE_LOCAL_NAME_PREFIXES } from '../constants.js';
import { errorMessage } from '../../util/errorMessage.js';
import { hexPreview } from '../../util/hexPreview.js';

/** UUIDs verified against pymammotion/bluetooth/const.py */
const UUID_SERVICE = BLE_SERVICE_UUID;
const UUID_WRITE_CHAR = '0000ff01-0000-1000-8000-00805f9b34fb';
const UUID_NOTIFY_CHAR = '0000ff02-0000-1000-8000-00805f9b34fb';

/** Conservative default — pymammotion assumes negotiated 517-byte ATT_MTU; Homey doesn't
 *  expose MTU negotiation, so start at BLE 4.0 default (20 bytes) until verified on device. */
const BLE_CHUNK_SIZE = 20;

/** Initial reconnect delay after BLE fails. Doubles on each consecutive failure,
 *  capped at BLE_RECONNECT_MAX_MS, to avoid hammering the radio indefinitely. */
const BLE_RECONNECT_BASE_MS = 15_000;
const BLE_RECONNECT_MAX_MS  = 4 * 60_000; // 4 min

/** After this many consecutive failures, BLE is treated as persistently unreachable for
 *  this device/hub combo — most commonly just distance/signal (the mower is out of BLE
 *  range of the hub), not a fault. MQTT is already carrying telemetry in that case, so we
 *  back off much further to avoid hammering the radio for a connection that isn't coming. */
const BLE_PERSISTENT_FAILURE_THRESHOLD = 5;
const BLE_RECONNECT_MAX_MS_QUIET = 30 * 60_000; // 30 min

/** Max time to wait for post-connect GATT setup before giving up and retrying.
 *  Homey's own BLE operation timeout is ~30s — too slow to wait on when the
 *  peripheral has already silently disconnected (observed on weak-signal links). */
const BLE_SETUP_TIMEOUT_MS = 8_000;

/** Minimal duck-type of the BLE manager — all BleTransport ever calls on it. */
interface BleManager {
  discover(serviceFilter?: string[]): Promise<Homey.BleAdvertisement[]>;
  find(peripheralUuid: string): Promise<Homey.BleAdvertisement>;
}

/** Fired with a decoded LubaMsg whenever a complete BLE notification frame is reassembled. */
export type BleMessageCallback = (iotId: string, decoded: Record<string, unknown>) => void;
/** Fired when the BLE connection to the mower is established or lost. */
export type BleStatusCallback = (iotId: string, connected: boolean) => void;

/**
 * BLE transport for Mammotion mowers using the Homey BLE API + BluFi framing.
 * Mirrors MqttClient's contract so the same telemetry/command pipeline (Codec.ts)
 * applies without modification. See docs/BLE_PLAN.md for the full analysis and open
 * questions to verify once tested against a real device.
 *
 * ⚠️  Real-device test (2026-06-30, Homey 3s / homey3s): the BLE scan found zero
 * matches because discover() was filtering by service UUID, and this mower's
 * advertisement payload carries an empty serviceUuids list (confirmed via Homey's
 * own BLE devtool) even though the ffff vendor service IS present once GATT-
 * connected. Fixed by dropping the service filter and matching on local name only.
 *
 * ⚠️  Real-device test #2 (2026-06-30, same hub): discovery and the BLE-level
 * connect() now both succeed (RSSI -86 to -102 dBm), but the peripheral
 * disconnects 2-10s later — before discoverServices/subscribeToNotifications
 * can finish. Consistent across 4 attempts. Most likely a weak-signal range
 * issue on this Homey 3s, not a code bug (the connect handshake itself works).
 * Added an 8s setup timeout (BLE_SETUP_TIMEOUT_MS) so a dropped peripheral is
 * detected and retried quickly instead of waiting Homey's own ~30s internal
 * BLE timeout. Notify/MTU/BluFi-framing remain unverified — setup has never
 * completed. See [[protocol-notes]] memory for the full writeup before
 * changing scan/connect logic again.
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
  private consecutiveFailures = 0;

  /** Cached after first discovery; persisted across restarts via device store. */
  private peripheralUuid: string | null;
  private onPeripheralUuid: ((uuid: string) => void) | undefined;

  constructor(opts: {
    /** Pass `this.homey.ble` from a Device or Driver. */
    bleManager: BleManager;
    iotId: string;
    deviceName: string;
    onMessage: BleMessageCallback;
    onStatus: BleStatusCallback;
    log: (msg: string) => void;
    logError: (msg: string) => void;
    /** Stored peripheral UUID from a prior session — skips full scan on reconnect. */
    peripheralUuid?: string | null;
    /** Called when a new UUID is learned so the caller can persist it. */
    onPeripheralUuid?: (uuid: string) => void;
  }) {
    this.bleManager = opts.bleManager;
    this.iotId = opts.iotId;
    this.deviceName = opts.deviceName;
    this.onMessage = opts.onMessage;
    this.onStatus = opts.onStatus;
    this.log = opts.log;
    this.logError = opts.logError;
    this.peripheralUuid = opts.peripheralUuid ?? null;
    this.onPeripheralUuid = opts.onPeripheralUuid;
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
        // the mower is simply out of BLE range of the hub) — log it quietly and
        // retry. logError is reserved for genuine protocol bugs, not range/signal.
        // Routed through reportFailure() (not a bare log()) so this counts toward
        // consecutiveFailures like every other failure path below — previously it
        // didn't, so a device that's never found (out of range for a long stretch,
        // or a hub with no BLE radio at all, e.g. a Homey Pro Mini without a Homey
        // Bridge) rescanned every 15s forever instead of ever reaching the 30-minute
        // quiet cap this backoff already has for exactly that persistent case. A
        // single successful connect still resets the counter to 0 below, so a mower
        // that comes back into range promptly returns to the fast 15s cadence.
        this.reportFailure(`BLE: device ${this.deviceName} not found in scan`);
        this.scheduleReconnect();
        return;
      }
      this.log(`BLE: found ${advertisement.localName} (RSSI ${advertisement.rssi})`);

      const peripheral = await advertisement.connect();
      this.peripheral = peripheral;

      let timeoutHandle: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        this.setupGattSession(peripheral),
        new Promise<'timeout'>((resolve) => { timeoutHandle = setTimeout(() => resolve('timeout'), BLE_SETUP_TIMEOUT_MS); }),
      ]);
      clearTimeout(timeoutHandle!);

      if (result === 'timeout') {
        // Peripheral likely dropped mid-setup (common on weak-signal links) — Homey's
        // own BLE operation timeout is ~30s, too slow to wait out before retrying.
        throw new Error(`GATT setup timed out after ${BLE_SETUP_TIMEOUT_MS}ms`);
      }
      if (result === 'no-service') {
        this.reportFailure(`BLE: service ${UUID_SERVICE} not found on ${this.deviceName}`);
        await this.disconnectPeripheral();
        this.scheduleReconnect();
        return;
      }

      this.consecutiveFailures = 0;
      this.onStatus(this.iotId, true);

      // One-shot BLE sync — same as pymammotion's _ble_sync(2) on connect.
      await this.sendBytes(buildBleSyncCommand(2, this.seq));
      this.log('BLE: sent todev_ble_sync(2)');

    } catch (err) {
      this.reportFailure(`BLE: connect failed: ${errorMessage(err)}`);
      this.onStatus(this.iotId, false);
      await this.disconnectPeripheral();
      this.scheduleReconnect();
    }
  }

  /** Counts a failed connect attempt. BLE is best-effort: failing to connect is most often
   *  just the mower being out of range of the hub, not a fault, so it's logged at info
   *  level rather than error — an error-level entry every few minutes for a mower that's
   *  simply parked at the far end of the garden would be misleading noise. */
  private reportFailure(message: string): void {
    this.consecutiveFailures++;
    this.log(message);
  }

  /** Discover the GATT service/characteristics and subscribe to notifications.
   *  Raced against BLE_SETUP_TIMEOUT_MS in connect() since a peripheral that
   *  disconnects mid-setup otherwise hangs these calls until Homey's own
   *  ~30s BLE operation timeout. */
  private async setupGattSession(peripheral: Homey.BlePeripheral): Promise<'ok' | 'no-service'> {
    // Discover ALL services (no UUID filter) — the filtered "Discover Primary Service by
    // UUID" GATT procedure has been observed to hang indefinitely on this mower's firmware,
    // while the unfiltered "Discover All Primary Services" procedure should be more reliable.
    const services = await peripheral.discoverServices();
    const service = services.find((s) => s.uuid === UUID_SERVICE) ?? null;
    if (!service) return 'no-service';

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
    return 'ok';
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

  /** Whether the BLE peripheral is currently connected. */
  get isConnected(): boolean {
    return this.peripheral?.isConnected ?? false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /** Locates the mower's BLE advertisement — via a cached UUID lookup first, then a fresh scan. */
  private async discoverMower(): Promise<Homey.BleAdvertisement | null> {
    // If we have a cached peripheralUuid from a prior session, use find() — it's a fast
    // point-to-point lookup recommended by Homey docs instead of a full scan.
    if (this.peripheralUuid) {
      try {
        const ad = await this.bleManager.find(this.peripheralUuid);
        this.log(`BLE: found ${ad.localName} via cached UUID (RSSI ${ad.rssi})`);
        return ad;
      } catch {
        // Peripheral not reachable by stored UUID — fall through to a fresh scan.
        this.log('BLE: cached UUID not found, falling back to full scan');
        this.peripheralUuid = null;
      }
    }

    // No service-UUID filter: confirmed via real-device test (2026-06-30) that this
    // mower's advertisement payload carries an empty serviceUuids list (Homey devtool
    // showed "Advertised service uuids: []") even though the ffff vendor service IS
    // present once GATT-connected. discover([UUID_SERVICE]) silently excludes it; match
    // by local name only. Service presence is verified post-connect via discoverServices.
    const ads = await this.bleManager.discover();
    this.log(`BLE: scan found ${ads.length} BLE advertisements`);
    const ad = ads.find(
      (a) => BLE_LOCAL_NAME_PREFIXES.some((prefix) => a.localName?.startsWith(prefix))
        && a.localName === this.deviceName,
    ) ?? null;

    if (ad) {
      // Persist the UUID so future reconnects skip the full scan.
      this.peripheralUuid = ad.uuid;
      this.onPeripheralUuid?.(ad.uuid);
    }
    return ad;
  }

  /** Feeds one raw GATT notification through the frame assembler and dispatches complete messages. */
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
      this.logError(`BLE: protobuf decode failed: ${errorMessage(err)} — payload: ${hexPreview(result.data)}`);
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

  /** Frames raw bytes via BluFi and writes each resulting fragment to the GATT write characteristic. */
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

  /** Clears connection state and triggers a reconnect attempt unless the transport was stopped. */
  private handleDisconnect(): void {
    this.writeChar = null;
    this.onStatus(this.iotId, false);
    if (!this.stopped) this.scheduleReconnect();
  }

  /** Schedules the next connect() attempt with exponential backoff based on consecutive failures. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const cap = this.consecutiveFailures > BLE_PERSISTENT_FAILURE_THRESHOLD
      ? BLE_RECONNECT_MAX_MS_QUIET
      : BLE_RECONNECT_MAX_MS;
    const delay = Math.min(BLE_RECONNECT_BASE_MS * (2 ** this.consecutiveFailures), cap);
    this.log(`BLE: scheduling reconnect in ${Math.round(delay / 1000)}s (failure #${this.consecutiveFailures})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Tears down the current peripheral connection, ignoring errors from an already-dead link. */
  private async disconnectPeripheral(): Promise<void> {
    const p = this.peripheral;
    this.peripheral = null;
    this.writeChar = null;
    if (p && p.isConnected) {
      await p.disconnect().catch(() => { /* ignore errors on cleanup */ });
    }
  }
}
