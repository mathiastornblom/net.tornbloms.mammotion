
import Homey from 'homey';
import type { DeviceContext, AuthSession } from '../../lib/mammotion/auth/types.js';
import { MqttClient, type TelemetryState } from '../../lib/mammotion/mqtt/MqttClient.js';
import { BleTransport } from '../../lib/mammotion/ble/BleTransport.js';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth.js';
import { extractTelemetry } from '../../lib/mammotion/protocol/TelemetryParser.js';
import { extractSchedule, type ScheduleInfo } from '../../lib/mammotion/protocol/ScheduleParser.js';
import {
  buildTaskControlCommand,
  buildStartMowCommand,
  buildRequestIotSyncCommand,
  buildSetBladeHeightCommand,
  buildReadScheduleCommand,
  type StartMowOptions,
} from '../../lib/mammotion/commands/LubaCommands.js';
import { MammotionError } from '../../lib/mammotion/errors.js';
import type LubaDriver from './driver.js';

type MowerStatus = 'idle' | 'mowing' | 'returning' | 'charging' | 'paused' | 'error';
type TransportName = 'ble' | 'mqtt' | 'none';
type TransportPreference = 'auto' | 'ble_only' | 'mqtt_only';

// Re-arm the one-shot report subscription every 5s, matching Mammotion-HA.
const TELEMETRY_POLL_INTERVAL_MS = 5_000;
const SYNC_ON_CONNECT_DELAY_MS = 2_000;

/** Maps raw work mode integers to Homey mower_status enum values. */
function workModeToStatus(mode: number): MowerStatus {
  switch (mode) {
    case 13: return 'mowing';
    case 14: return 'returning';
    case 15:
    case 39: return 'charging';
    case 19: return 'paused';
    case 20: return 'mowing';
    case 37:
    case 23: return 'error';
    default: return 'idle';
  }
}

function isErrorMode(mode: number): boolean {
  return mode === 37 || mode === 23 || mode === 38;
}

/**
 * LubaDevice represents a single Mammotion mower paired to Homey.
 * Supports dual-mode transport (BLE preferred, MQTT fallback, or explicit preference
 * via device settings). Commands are routed to whichever transport is active; the
 * active transport is logged on every telemetry update and switch event for diagnostics.
 */
export default class LubaDevice extends Homey.Device {

  private mqtt: MqttClient | null = null;
  private ble: BleTransport | null = null;
  private activeTransport: TransportName = 'none';

  private pollTimer: NodeJS.Timeout | null = null;
  private mqttReconnectTimer: NodeJS.Timeout | null = null;
  private mqttFailureCount = 0;

  private seq = { value: 0 };
  private currentStatus: MowerStatus = 'idle';

  // ─── Init / teardown ─────────────────────────────────────────────────────

  async onInit(): Promise<void> {
    this.log(`LubaDevice ${this.getName()} initializing (preference=${this.transportPreference()})`);

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await (value ? this.actionStartMowing({}) : this.actionDock());
    });

    this.registerCapabilityListener('mow_blade_height', async (value: number) => {
      await this.sendBladeHeight(value);
    });

    await this.startTransports();
  }

  /** Called by the driver after a successful Repair — retries with fresh cloud session. */
  async retryAfterRepair(): Promise<void> {
    this.mqttFailureCount = 0;
    this.log('Retrying all transports after repair');
    await this.startTransports();
  }

  async onDeleted(): Promise<void> { this.cleanup(); }
  async onUninit(): Promise<void> { this.cleanup(); }

  /** React to preference setting change without restarting Homey. */
  async onSettings({ changedKeys }: { changedKeys: string[]; newSettings: Record<string, unknown>; oldSettings: Record<string, unknown> }): Promise<void> {
    if (changedKeys.includes('transport_preference')) {
      const pref = this.transportPreference();
      this.log(`Transport preference changed → ${pref}; restarting transports`);
      this.cleanup();
      await this.startTransports();
    }
  }

  // ─── Transport lifecycle ──────────────────────────────────────────────────

  private transportPreference(): TransportPreference {
    return (this.getSetting('transport_preference') as TransportPreference | null) ?? 'auto';
  }

  private async startTransports(): Promise<void> {
    const pref = this.transportPreference();
    this.log(`startTransports: preference=${pref}`);

    const useBle = pref === 'auto' || pref === 'ble_only';
    const useMqtt = pref === 'auto' || pref === 'mqtt_only';

    if (useBle) await this.connectBle();
    if (useMqtt) {
      await this.connectMqtt();
      this.startPollTimer();
    }
  }

  // ─── BLE transport ────────────────────────────────────────────────────────

  private async connectBle(): Promise<void> {
    const context = this.getContext();
    if (!context.recordDeviceName) {
      this.log('BLE: skipping — recordDeviceName not available');
      return;
    }

    this.log(`BLE: initialising transport for ${context.recordDeviceName}`);
    this.ble = new BleTransport({
      bleManager: this.homey.ble,
      iotId: this.getData().id as string,
      deviceName: context.recordDeviceName,
      onMessage: (iotId, decoded) => this.handleBleMessage(iotId, decoded),
      onStatus: (iotId, connected) => {
        if (iotId !== this.getData().id) return;
        if (connected) {
          this.log('BLE: connected — switching active transport to BLE');
          this.switchActiveTransport('ble');
          this.setAvailable().catch(this.error.bind(this));
        } else {
          this.log(`BLE: disconnected (active was ${this.activeTransport})`);
          if (this.activeTransport === 'ble') {
            this.switchActiveTransport(this.mqtt?.isConnected ? 'mqtt' : 'none');
          }
        }
      },
      peripheralUuid: this.getStoreValue('blePeripheralUuid') as string | null,
      onPeripheralUuid: (uuid) => this.setStoreValue('blePeripheralUuid', uuid).catch(this.error.bind(this)),
      log: (msg) => this.log(`[BLE] ${msg}`),
      logError: (msg) => this.error(`[BLE] ${msg}`),
    });

    void this.ble.connect();
  }

  private handleBleMessage(iotId: string, decoded: Record<string, unknown>): void {
    if (iotId !== this.getData().id) return;
    const telemetry = extractTelemetry(decoded);
    if (telemetry) {
      if (this.activeTransport !== 'ble') this.switchActiveTransport('ble');
      this.handleTelemetry(iotId, telemetry, 'ble');
    }
    this.handleRawMessage(iotId, decoded);
  }

  /** Dispatch on-demand (non-telemetry) responses, e.g. schedule reads. */
  private handleRawMessage(iotId: string, msg: Record<string, unknown>): void {
    if (iotId !== this.getData().id) return;
    const schedule = extractSchedule(msg);
    if (schedule) this.handleScheduleResponse(schedule);
  }

  private handleScheduleResponse(schedule: ScheduleInfo): void {
    this.log(
      `Schedule [${schedule.planIndex + 1}/${schedule.totalPlanCount || '?'}] `
      + `id=${schedule.planId || '(none)'} name="${schedule.taskName}" `
      + `${schedule.startTime}-${schedule.endTime} `
      + `week=${schedule.week} weeks=[${schedule.weeks.join(',')}] `
      + `dates=${schedule.startDate || '-'}..${schedule.endDate || '-'} `
      + `blade=${schedule.bladeHeightMm}mm speed=${schedule.speedMs}m/s`,
    );
  }

  /** Diagnostic/read-only: request the mower's stored mowing schedule (logged, not yet
   *  surfaced as a capability — see docs/SCHEDULING_PLAN.md for why writes aren't supported). */
  async requestSchedule(planIndex = 0): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildReadScheduleCommand(session.userAccount, context.deviceName, planIndex, this.seq, context.productKey);
    await this.sendRaw(Buffer.from(cmd, 'base64'), 'read_schedule');
  }

  // ─── MQTT transport ───────────────────────────────────────────────────────

  private async connectMqtt(): Promise<void> {
    if (this.mqttReconnectTimer) {
      clearTimeout(this.mqttReconnectTimer);
      this.mqttReconnectTimer = null;
    }

    try {
      const session = await this.getSession().catch((err) => {
        throw new Error(`getSession: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.log(`cloud session OK (iotDomain=${session.iotDomain}, userAccount=${session.userAccount})`);

      const [devices, records] = await Promise.all([
        MammotionAuth.fetchDevices(session).catch((err) => { throw new Error(`fetchDevices: ${err instanceof Error ? err.message : String(err)}`); }),
        MammotionAuth.fetchDeviceRecords(session).catch((err) => { throw new Error(`fetchDeviceRecords: ${err instanceof Error ? err.message : String(err)}`); }),
      ]);

      const ownedByIotId = new Map(devices.map(d => [d.iotId, d]));
      const contexts = records.map(r => MammotionAuth.mergeDeviceContext(ownedByIotId.get(r.iotId) ?? {}, r));
      const thisContext = contexts.find(c => c.iotId === this.getData().id);
      this.log(`devices fetched: owned=${devices.length} records=${records.length}; `
        + `this device: ${thisContext ? `productKey=${thisContext.productKey} name=${thisContext.recordDeviceName}` : 'NOT FOUND in records'}`);

      const mqttCreds = await MammotionAuth.fetchMqttCredentials(session).catch((err) => {
        throw new Error(`fetchMqttCredentials: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.log(`MQTT credentials OK (host=${mqttCreds.host})`);

      if (!this.mqtt) {
        this.mqtt = new MqttClient({
          onTelemetry: (iotId, state) => {
            if (this.activeTransport === 'ble') return; // BLE is primary; discard MQTT telemetry
            this.handleTelemetry(iotId, state, 'mqtt');
          },
          onStatus: (iotId, online) => this.handleMqttStatus(iotId, online),
          onNotification: () => { /* poll timer handles keep-alive */ },
          onRawMessage: (iotId, msg) => this.handleRawMessage(iotId, msg),
          onClose: () => this.scheduleMqttReconnect(),
          log: (msg) => this.log(`[MQTT] ${msg}`),
          logError: (msg) => this.error(`[MQTT] ${msg}`),
        });
      }

      this.mqtt.connect(mqttCreds, contexts);

      setTimeout(() => {
        this.requestSync().catch((err) => {
          this.error(`Initial sync failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, SYNC_ON_CONNECT_DELAY_MS);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`MQTT connect failed: ${message}`);

      const isAuthFailure = message.includes(this.homey.__('error.invalid_credentials'))
        || message.includes(this.homey.__('error.not_authenticated'));
      if (isAuthFailure) {
        this.setUnavailable(this.homey.__('error.invalid_credentials')).catch(this.error.bind(this));
        return;
      }
      this.scheduleMqttReconnect();
    }
  }

  private handleMqttStatus(iotId: string, online: boolean): void {
    if (iotId !== this.getData().id) return;
    if (online) {
      // Only become available/primary if BLE isn't already providing telemetry.
      if (this.activeTransport === 'none') {
        this.log('MQTT: online — switching active transport to MQTT');
        this.switchActiveTransport('mqtt');
        this.setAvailable().catch(this.error.bind(this));
      } else {
        this.log(`MQTT: online (BLE=${this.activeTransport === 'ble'} remains primary)`);
      }
    } else {
      if (this.activeTransport === 'mqtt') {
        this.log('MQTT: offline');
        this.switchActiveTransport('none');
        this.setUnavailable(this.homey.__('error.device_offline')).catch(this.error.bind(this));
      }
    }
  }

  private scheduleMqttReconnect(): void {
    if (this.mqttReconnectTimer) return;
    this.mqttFailureCount += 1;
    const delayMs = Math.min(60_000, 10_000 * this.mqttFailureCount);
    this.log(`Scheduling MQTT reconnect in ${delayMs}ms (attempt ${this.mqttFailureCount})`);
    this.mqttReconnectTimer = setTimeout(() => {
      this.mqttReconnectTimer = null;
      void this.connectMqtt();
    }, delayMs);
  }

  // ─── Transport switching ──────────────────────────────────────────────────

  private switchActiveTransport(to: TransportName): void {
    if (this.activeTransport === to) return;
    this.log(`Transport switch: ${this.activeTransport} → ${to}`);
    this.activeTransport = to;
    this.setCapIfChanged('active_transport', to);
    // Reset MQTT failure count when BLE takes over — MQTT hasn't actually failed.
    if (to === 'ble') this.mqttFailureCount = 0;
  }

  // ─── Telemetry ────────────────────────────────────────────────────────────

  private startPollTimer(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.requestSync();
      } catch (err) {
        this.error(`Poll sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, TELEMETRY_POLL_INTERVAL_MS);
  }

  private async requestSync(): Promise<void> {
    if (this.activeTransport === 'ble') return; // BLE pushes on its own; no poll needed
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildRequestIotSyncCommand(session.userAccount, false, this.seq);
    await this.mqtt?.sendCommand(session, context, cmd);
  }

  private setCapIfChanged(capability: string, value: number | string | boolean): boolean {
    if (this.getCapabilityValue(capability) === value) return false;
    this.setCapabilityValue(capability, value).catch(this.error.bind(this));
    return true;
  }

  private handleTelemetry(iotId: string, state: Partial<TelemetryState>, via: TransportName): void {
    if (iotId !== this.getData().id) return;
    this.mqttFailureCount = 0;

    const changed: string[] = [];

    if (state.batteryPercent != null) {
      if (this.setCapIfChanged('measure_battery', state.batteryPercent)) {
        changed.push(`battery=${state.batteryPercent}`);
        (this.driver as unknown as LubaDriver).triggerBatteryBelow(this, state.batteryPercent);
      }
    }
    if (state.workMode != null) {
      const status = workModeToStatus(state.workMode);
      if (status !== this.currentStatus) changed.push(`status=${status}(${state.workMode})`);
      this.updateMowerStatus(status, state.workMode);
    }
    if (state.progress != null && this.setCapIfChanged('measure_mow_progress', state.progress)) changed.push(`progress=${state.progress}`);
    if (state.area != null && this.setCapIfChanged('measure_mow_area', state.area)) changed.push(`area=${state.area}`);
    if (state.bladeHeight != null && this.setCapIfChanged('mow_blade_height', state.bladeHeight)) changed.push(`blade=${state.bladeHeight}`);
    if (state.wifiRssi != null && this.setCapIfChanged('measure_wifi_rssi', state.wifiRssi)) changed.push(`wifi=${state.wifiRssi}`);
    if (state.bleRssi != null && this.setCapIfChanged('measure_ble_rssi', state.bleRssi)) changed.push(`ble=${state.bleRssi}`);
    if (state.gpsStars != null && this.setCapIfChanged('measure_gps_stars', state.gpsStars)) changed.push(`gps=${state.gpsStars}`);
    if (state.mowingSpeed != null && this.setCapIfChanged('measure_mowing_speed', state.mowingSpeed)) changed.push(`speed=${state.mowingSpeed}`);
    if (state.elapsedTime != null && this.setCapIfChanged('measure_elapsed_time', state.elapsedTime)) changed.push(`elapsed=${state.elapsedTime}`);
    if (state.leftTime != null && this.setCapIfChanged('measure_left_time', state.leftTime)) changed.push(`left=${state.leftTime}`);

    if (changed.length > 0) this.log(`[${via}] telemetry changed: ${changed.join(' ')}`);
  }

  private updateMowerStatus(status: MowerStatus, rawMode: number): void {
    const wasStatus = this.currentStatus;
    this.currentStatus = status;

    this.setCapIfChanged('mower_status', status);
    this.setCapIfChanged('onoff', status === 'mowing');
    this.setCapIfChanged('alarm_generic', isErrorMode(rawMode));

    if (status === wasStatus) return;
    const driver = this.driver as unknown as LubaDriver;
    if (status === 'mowing') driver.triggerMowerStartedMowing(this);
    else if (status === 'charging') driver.triggerMowerDocked(this);
    else if (status === 'error') driver.triggerMowerError(this);
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  /** Choose which transport to route a raw-bytes command through. */
  private async sendRaw(bytes: Buffer, label: string): Promise<void> {
    if (this.activeTransport === 'ble' && this.ble?.isConnected) {
      this.log(`[BLE] sending command: ${label}`);
      await this.ble.send(bytes);
    } else if (this.mqtt?.isConnected) {
      const session = await this.getSession();
      const context = this.getContext();
      this.log(`[MQTT] sending command: ${label}`);
      const b64 = bytes.toString('base64');
      const result = await Promise.race([
        this.mqtt.sendCommand(session, context, b64),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Command timeout: ${label}`)), 10_000)),
      ]);
      this.log(`[MQTT] command ${label} response: ${String(result).substring(0, 100)}`);
    } else {
      throw new MammotionError(`No transport available for command: ${label}`);
    }
  }

  async actionStartMowing(options: StartMowOptions): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    if (typeof options.bladeHeight === 'number') await this.sendBladeHeight(options.bladeHeight);
    const bytes = Buffer.from(buildStartMowCommand(options, session.userAccount, context.deviceName, this.seq, context.productKey), 'base64');
    await this.sendRaw(bytes, 'start_mowing');
  }

  async actionDock(): Promise<void> { await this.sendTaskControlRaw('dock'); }
  async actionPause(): Promise<void> { await this.sendTaskControlRaw('pause'); }
  async actionStop(): Promise<void> { await this.sendTaskControlRaw('stop'); }

  private async sendTaskControlRaw(command: 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock'): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const bytes = Buffer.from(buildTaskControlCommand(command, session.userAccount, context.deviceName, this.seq, context.productKey), 'base64');
    await this.sendRaw(bytes, command);
  }

  private async sendBladeHeight(heightMm: number): Promise<void> {
    const session = await this.getSession();
    const bytes = Buffer.from(buildSetBladeHeightCommand(heightMm, session.userAccount, this.seq), 'base64');
    await this.sendRaw(bytes, 'set_blade_height');
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  private cleanup(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.mqttReconnectTimer) { clearTimeout(this.mqttReconnectTimer); this.mqttReconnectTimer = null; }
    this.mqtt?.disconnect();
    this.mqtt = null;
    void this.ble?.disconnect();
    this.ble = null;
    this.activeTransport = 'none';
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getMowerState(): MowerStatus { return this.currentStatus; }
  private getContext(): DeviceContext { return this.getStoreValue('context') as DeviceContext; }
  private async getSession(): Promise<AuthSession> {
    return (this.driver as any).getValidSession() as Promise<AuthSession>;
  }
}
