
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
  buildSetBladeSpeedCommand,
  buildSetHeadlampCommand,
  buildSetRainProtectionCommand,
  buildReadScheduleCommand,
  CUTTER_MODE_MAP,
  type StartMowOptions,
} from '../../lib/mammotion/commands/LubaCommands.js';
import { MammotionError, AliyunCommandError, DeviceOfflineError } from '../../lib/mammotion/errors.js';
import { sendAliyunCloudCommand } from '../../lib/mammotion/aliyun/commands.js';
import type LubaDriver from './driver.js';

type MowerStatus = 'idle' | 'mowing' | 'returning' | 'charging' | 'paused' | 'error';
type TransportName = 'ble' | 'mqtt' | 'aliyun_legacy' | 'none';
type TransportPreference = 'auto' | 'ble_only' | 'mqtt_only';

// Re-arm the one-shot report subscription every 5s, matching Mammotion-HA.
const TELEMETRY_POLL_INTERVAL_MS = 5_000;
const SYNC_ON_CONNECT_DELAY_MS = 2_000;
// Once the mower has confirmed itself offline (DeviceOfflineError, not just a transient
// send failure), polling every 5s indefinitely is wasted cloud traffic for a mower that
// could be powered off for a while — back off, but cap low (60s, matching
// scheduleMqttReconnect's own cap below) rather than minutes: a user coming home and
// switching the mower back on expects Homey to notice within well under a minute, not
// however long a looser cap would allow.
const OFFLINE_POLL_BASE_MS = 10_000;
const OFFLINE_POLL_MAX_MS = 60_000; // 1 min

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

/** Whether a raw work-mode integer represents an error/fault state. */
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
  /** Consecutive confirmed-offline poll results — drives OFFLINE_POLL_* backoff. Reset to 0
   *  the moment a poll succeeds or any online-transition callback fires (markOnline). */
  private offlinePollFailureCount = 0;

  private seq = { value: 0 };
  private currentStatus: MowerStatus = 'idle';
  /** Last logged headlampStatusRaw value — diagnostic change-gating only, not a capability. */
  private lastHeadlampStatusRaw: number | null = null;

  // ─── Init / teardown ─────────────────────────────────────────────────────

  /** Registers capability listeners and starts BLE/MQTT transports per the device's transport_preference setting. */
  async onInit(): Promise<void> {
    this.log(`LubaDevice ${this.getName()} initializing (preference=${this.transportPreference()})`);

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await (value ? this.actionStartMowing({}) : this.actionDock());
    });

    this.registerCapabilityListener('mow_blade_height', async (value: number) => {
      await this.sendBladeHeight(value);
    });

    this.registerCapabilityListener('mow_cutter_mode', async (value: string) => {
      await this.actionSetBladeSpeed(value as 'economic' | 'standard' | 'performance');
    });

    this.registerCapabilityListener('mow_headlamp', async (value: boolean) => {
      await this.actionSetHeadlamp(value, 0);
    });

    this.registerCapabilityListener('mow_side_led', async (value: boolean) => {
      await this.actionSetHeadlamp(value, 1);
    });

    this.registerCapabilityListener('mow_rain_protection', async (value: boolean) => {
      await this.actionSetRainProtection(value);
    });

    this.registerCapabilityListener('mow_send_to_dock', async () => {
      await this.actionDock();
    });

    // Ensure sensor shows "Disconnected" immediately rather than blank until a transport connects.
    this.setCapabilityValue('active_transport', 'none').catch(this.error.bind(this));
    // mow_cutter_mode has no read-back from telemetry, so default to standard on init.
    if (this.getCapabilityValue('mow_cutter_mode') === null) {
      this.setCapabilityValue('mow_cutter_mode', 'standard').catch(this.error.bind(this));
    }

    await this.startTransports();
  }

  /** Called by the driver after a successful Repair — retries with fresh cloud session. */
  async retryAfterRepair(): Promise<void> {
    this.mqttFailureCount = 0;
    this.offlinePollFailureCount = 0;
    this.log('Retrying all transports after repair');
    await this.startTransports();
  }

  /** Tears down transports when the device is removed from Homey. */
  async onDeleted(): Promise<void> { this.cleanup(); }
  /** Tears down transports when the Homey app is restarted/updated. */
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

  /** Reads the user-configured transport_preference setting, defaulting to 'auto'. */
  private transportPreference(): TransportPreference {
    return (this.getSetting('transport_preference') as TransportPreference | null) ?? 'auto';
  }

  /** Starts BLE and/or the cloud transport (Mammotion MQTT, or the legacy Aliyun connection
   *  for 'aliyun_legacy'-flagged devices) according to the current transport preference.
   *  'mqtt_only' is interpreted as "cloud only" for either device type — there's no
   *  separate preference value for the legacy cloud, since users can't tell which system
   *  their mower uses (see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md §1). */
  private async startTransports(): Promise<void> {
    const pref = this.transportPreference();
    const isLegacy = this.getContext().transportKind === 'aliyun_legacy';
    this.log(`startTransports: preference=${pref} transportKind=${isLegacy ? 'aliyun_legacy' : 'mammotion'}`);

    const useBle = pref === 'auto' || pref === 'ble_only';
    const useCloud = pref === 'auto' || pref === 'mqtt_only';

    if (useBle) await this.connectBle();
    if (useCloud && isLegacy) {
      await this.connectAliyunLegacy();
      // Was missing entirely for legacy devices — requestSync() (which the v2.5.11 fix
      // taught how to reach a legacy device) was never actually being called at all, since
      // nothing ever started the poll loop that calls it. Confirmed via a real diagnostic
      // report (2026-07-04) showing a fully healthy Aliyun connection with zero requestSync
      // activity ever logged, only the capability-restoration set_* commands from onInit.
      this.startPollTimer();
    } else if (useCloud) {
      await this.connectMqtt();
      this.startPollTimer();
    }
  }

  // ─── BLE transport ────────────────────────────────────────────────────────

  /** Constructs and starts the BleTransport for this device's mower. */
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
          this.markOnline();
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

  /** Routes a decoded BLE LubaMsg to telemetry handling and raw-message dispatch. */
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

  /** Logs a parsed schedule read response for diagnostics. */
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

  /** Fetches a fresh session and MQTT credentials, then connects the MqttClient for this device. */
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

      const [devices, recordsResult] = await Promise.all([
        MammotionAuth.fetchDevices(session).catch((err) => { throw new Error(`fetchDevices: ${err instanceof Error ? err.message : String(err)}`); }),
        MammotionAuth.fetchDeviceRecords(session).catch((err) => { throw new Error(`fetchDeviceRecords: ${err instanceof Error ? err.message : String(err)}`); }),
      ]);
      const records = recordsResult.records;

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
            if (this.activeTransport !== 'mqtt') {
              this.switchActiveTransport('mqtt');
              this.markOnline();
            }
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

      // The stored session can look client-side valid (expiresAt in the future) while the
      // server has already revoked it — the API then answers every call with its own
      // `code: 401`, and without this, the same broken token gets retried forever with
      // just a growing backoff (see a real diagnostic report stuck in this loop for 4+
      // minutes). Drop the cache so the next reconnect attempt forces a fresh login.
      if (message.includes('API error 401')) {
        (this.driver as unknown as LubaDriver).invalidateSession();
      }
      this.scheduleMqttReconnect();
    }
  }

  /** Updates the active transport and device availability based on the mower's MQTT online status. */
  private handleMqttStatus(iotId: string, online: boolean): void {
    if (iotId !== this.getData().id) return;
    if (online) {
      // Only become available/primary if BLE isn't already providing telemetry.
      if (this.activeTransport === 'none') {
        this.log('MQTT: online — switching active transport to MQTT');
        this.switchActiveTransport('mqtt');
        this.markOnline();
      } else {
        this.log(`MQTT: online (BLE=${this.activeTransport === 'ble'} remains primary)`);
      }
    } else if (this.activeTransport === 'mqtt') {
      this.log('MQTT: offline');
      this.switchActiveTransport('none');
      this.markOffline();
    }
  }

  /** Schedules the next connectMqtt() attempt with linear backoff, capped at 60s. */
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

  // ─── Legacy Aliyun transport ──────────────────────────────────────────────
  // 'aliyun_legacy'-flagged devices only — a completely different cloud system from the
  // Mammotion MQTT above. The connection itself is owned/shared by LubaDriver across every
  // legacy device on the account (see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md §1/§3); this
  // device only registers itself onto it and reacts to routed callbacks.

  /** Registers this device on the driver's shared AliyunMqttTransport (creating/connecting
   *  it on first use). Failure here is logged, not fatal — BLE (if in range) still works,
   *  and startTransports()'s BLE branch runs independently of this one. */
  private async connectAliyunLegacy(): Promise<void> {
    const driver = this.driver as unknown as LubaDriver;
    try {
      await driver.registerAliyunDevice(
        this.getData().id as string,
        (decoded) => this.handleAliyunMessage(decoded),
        (online) => this.handleAliyunStatus(online),
      );
      this.log('[Aliyun] registered on shared transport');
    } catch (err) {
      this.error(`[Aliyun] registerAliyunDevice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Routes a decoded legacy-Aliyun LubaMsg to telemetry handling and raw-message dispatch —
   *  mirrors handleBleMessage, minus the iotId filter (the shared transport already routes
   *  by iotId before invoking this callback). */
  private handleAliyunMessage(decoded: Record<string, unknown>): void {
    const iotId = this.getData().id as string;
    const telemetry = extractTelemetry(decoded);
    if (telemetry) {
      if (this.activeTransport !== 'ble') this.switchActiveTransport('aliyun_legacy');
      this.handleTelemetry(iotId, telemetry, 'aliyun_legacy');
    }
    this.handleRawMessage(iotId, decoded);
  }

  /** Updates active transport/availability based on the shared Aliyun connection's status —
   *  mirrors handleMqttStatus's "don't override BLE if it's already primary" logic. */
  private handleAliyunStatus(online: boolean): void {
    if (online) {
      if (this.activeTransport === 'none') {
        this.log('[Aliyun] online — switching active transport to aliyun_legacy');
        this.switchActiveTransport('aliyun_legacy');
        this.markOnline();
      }
    } else if (this.activeTransport === 'aliyun_legacy') {
      this.log('[Aliyun] offline');
      this.switchActiveTransport('none');
      this.markOffline();
    }
  }

  // ─── Transport switching ──────────────────────────────────────────────────

  /** Updates the active_transport capability and internal state when the primary transport changes. */
  private switchActiveTransport(to: TransportName): void {
    if (this.activeTransport === to) return;
    this.log(`Transport switch: ${this.activeTransport} → ${to}`);
    this.activeTransport = to;
    this.setCapIfChanged('active_transport', to);
    // Reset MQTT failure count when BLE takes over — MQTT hasn't actually failed.
    if (to === 'ble') this.mqttFailureCount = 0;
  }

  // ─── Telemetry ────────────────────────────────────────────────────────────

  /** Starts the periodic re-arm of the one-shot telemetry report subscription (MQTT mode only). */
  private startPollTimer(): void {
    this.schedulePoll(TELEMETRY_POLL_INTERVAL_MS);
  }

  /** Schedules the next poll tick — a plain setTimeout, not setInterval, so the delay can
   *  vary per tick (normal cadence while reachable, backed off once confirmed offline). */
  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      void this.runPollTick();
    }, delayMs);
  }

  /** Runs one requestSync() attempt and reschedules the next one. A confirmed
   *  DeviceOfflineError backs off exponentially (OFFLINE_POLL_BASE_MS → _MAX_MS, same
   *  backoff shape as BleTransport) instead of hammering the cloud every 5s for a mower
   *  that could be powered off for hours; any other outcome (success, or a
   *  non-offline error, which is likely transient) keeps the normal fast cadence. */
  private async runPollTick(): Promise<void> {
    try {
      await this.requestSync();
      this.offlinePollFailureCount = 0;
      this.schedulePoll(TELEMETRY_POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof DeviceOfflineError) {
        this.offlinePollFailureCount += 1;
        const delay = Math.min(OFFLINE_POLL_BASE_MS * (2 ** this.offlinePollFailureCount), OFFLINE_POLL_MAX_MS);
        this.log(`Poll: mower still offline — next check in ${Math.round(delay / 1000)}s (failure #${this.offlinePollFailureCount})`);
        this.schedulePoll(delay);
      } else {
        this.error(`Poll sync failed: ${err instanceof Error ? err.message : String(err)}`);
        this.schedulePoll(TELEMETRY_POLL_INTERVAL_MS);
      }
    }
  }

  /** Re-arms the one-shot telemetry report subscription. No-op while BLE is primary — BLE
   *  pushes on its own, no poll needed. */
  private async requestSync(): Promise<void> {
    if (this.activeTransport === 'ble') return;
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildRequestIotSyncCommand(session.userAccount, false, this.seq);
    // this.mqtt is never initialised for an aliyun_legacy device (startTransports() calls
    // connectAliyunLegacy() instead of connectMqtt()) — `this.mqtt?.sendCommand(...)` used to
    // silently no-op here every poll tick for those devices, so the mower was never actually
    // asked to report anything and no telemetry ever arrived, even once the Aliyun MQTT
    // connection itself was healthy (confirmed via a real diagnostic report, 2026-07-04).
    if (context.transportKind === 'aliyun_legacy') {
      await this.sendAliyunRaw(Buffer.from(cmd, 'base64'), 'requestSync', context.iotId);
      return;
    }
    try {
      await this.mqtt?.sendCommand(session, context, cmd);
    } catch (err) {
      this.handleMqttCommandError(err);
    }
  }

  /** Reacts to an MQTT command failure — if the mower itself reported it's offline
   *  (DeviceOfflineError), reflect that on Homey immediately rather than waiting for a
   *  status/telemetry signal that will never arrive from an offline device (BLE-out-of-
   *  range mowers can otherwise sit "available" indefinitely — see the diagnostic report
   *  that prompted this). Always re-throws so callers still see/log the original failure. */
  private handleMqttCommandError(err: unknown): never {
    if (err instanceof DeviceOfflineError) {
      this.log(`[MQTT] device reported offline: ${err.message}`);
      if (this.activeTransport === 'mqtt') this.switchActiveTransport('none');
      this.markOffline();
    }
    throw err;
  }

  /** Marks the device available and fires the mower_online Flow trigger, but only on an
   *  actual offline→online transition — safe to call repeatedly (e.g. from every telemetry
   *  update) without re-firing the trigger each time. */
  private markOnline(): void {
    const wasAvailable = this.getAvailable();
    this.setAvailable().catch(this.error.bind(this));
    if (!wasAvailable) (this.driver as unknown as LubaDriver).triggerMowerOnline(this);
  }

  /** Marks the device unavailable and fires the mower_offline Flow trigger, but only on an
   *  actual online→offline transition — safe to call repeatedly (e.g. from a poll that
   *  keeps confirming the mower is still offline) without spamming the trigger. */
  private markOffline(): void {
    const wasAvailable = this.getAvailable();
    this.setUnavailable(this.homey.__('error.device_offline')).catch(this.error.bind(this));
    if (wasAvailable) (this.driver as unknown as LubaDriver).triggerMowerOffline(this);
  }

  /** Writes a capability value only if it differs from the current one, to avoid redundant Homey updates. */
  private setCapIfChanged(capability: string, value: number | string | boolean): boolean {
    if (this.getCapabilityValue(capability) === value) return false;
    this.setCapabilityValue(capability, value).catch(this.error.bind(this));
    return true;
  }

  /** Applies a decoded telemetry update to Homey capabilities and fires Flow triggers as needed. */
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
    if (state.posLevel != null) {
      const posEnum = LubaDevice.posLevelToEnum(state.posLevel);
      if (this.setCapIfChanged('mow_pos_level', posEnum)) changed.push(`pos=${posEnum}(${state.posLevel})`);
    }
    if (state.batteryCycles != null && this.setCapIfChanged('measure_battery_cycles', state.batteryCycles)) changed.push(`cycles=${state.batteryCycles}`);
    if (state.bladeUsedTime != null) {
      // bladeUsedTime is in minutes; expose as hours with 1 decimal
      const hours = Math.round(state.bladeUsedTime / 6) / 10;
      if (this.setCapIfChanged('measure_blade_used_time', hours)) changed.push(`blade=${hours}h`);
    }
    // Diagnostic-only, not a capability yet — see TelemetryParser.ts's comment on
    // headlampStatusRaw. Logging every observed value (change-gated like everything
    // else here) so real device data can be collected before mapping this to
    // mow_headlamp/mow_side_led.
    if (state.headlampStatusRaw != null && state.headlampStatusRaw !== this.lastHeadlampStatusRaw) {
      this.lastHeadlampStatusRaw = state.headlampStatusRaw;
      changed.push(`headlampStatusRaw=${state.headlampStatusRaw} [diagnostic, not yet mapped]`);
    }

    if (changed.length > 0) this.log(`[${via}] telemetry changed: ${changed.join(' ')}`);
  }

  /** Updates the mower_status/onoff/alarm_generic capabilities and fires the matching Flow trigger on transition. */
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

  /** Choose which transport to route a raw-bytes command through. BLE is tried first
   *  whenever it's actually connected, regardless of transportKind — it's local and
   *  protocol-identical either way. Below that, branch by transportKind: legacy-Aliyun
   *  devices send via the REST invoke gateway (independent of the shared MQTT connection's
   *  status — sending doesn't need the read/telemetry connection up), everything else uses
   *  the primary Mammotion MQTT client. */
  private async sendRaw(bytes: Buffer, label: string): Promise<void> {
    const context = this.getContext();
    if (this.activeTransport === 'ble' && this.ble?.isConnected) {
      this.log(`[BLE] sending command: ${label}`);
      await this.ble.send(bytes);
    } else if (context.transportKind === 'aliyun_legacy') {
      await this.sendAliyunRaw(bytes, label, context.iotId);
    } else if (this.mqtt?.isConnected) {
      const session = await this.getSession();
      this.log(`[MQTT] sending command: ${label}`);
      const b64 = bytes.toString('base64');
      try {
        const result = await Promise.race([
          this.mqtt.sendCommand(session, context, b64),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Command timeout: ${label}`)), 10_000)),
        ]);
        this.log(`[MQTT] command ${label} response: ${String(result).substring(0, 100)}`);
      } catch (err) {
        this.handleMqttCommandError(err);
      }
    } else {
      throw new MammotionError(`No transport available for command: ${label}`);
    }
  }

  /** Sends a command via the legacy Aliyun REST invoke gateway. On an auth-expiry error
   *  (460/29003 — see AliyunCommandError), drops the driver's cached credentials and
   *  retries exactly once with a freshly re-derived set, rather than failing permanently
   *  on a stale cached iotToken (full refresh-before-expiry isn't implemented yet — see
   *  docs/ALIYUN_MQTT_TRANSPORT_PLAN.md Stage 3). */
  private async sendAliyunRaw(bytes: Buffer, label: string, iotId: string): Promise<void> {
    const driver = this.driver as unknown as LubaDriver;
    this.log(`[Aliyun] sending command: ${label}`);
    const credentials = await driver.getAliyunCredentials();
    try {
      const messageId = await sendAliyunCloudCommand(credentials, iotId, bytes);
      this.log(`[Aliyun] command ${label} sent (messageId=${messageId})`);
    } catch (err) {
      const isAuthExpired = err instanceof AliyunCommandError && (err.code === 460 || err.code === 29003);
      if (!isAuthExpired) throw err;
      this.log(`[Aliyun] command ${label} failed with auth-expiry (code=${(err as AliyunCommandError).code}) — retrying once with fresh credentials`);
      driver.invalidateAliyunCredentials();
      const freshCredentials = await driver.getAliyunCredentials();
      const messageId = await sendAliyunCloudCommand(freshCredentials, iotId, bytes);
      this.log(`[Aliyun] command ${label} sent on retry (messageId=${messageId})`);
    }
  }

  /** Starts (or resumes) the mower's configured job, applying blade height first if given. */
  async actionStartMowing(options: StartMowOptions): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    if (typeof options.bladeHeight === 'number') await this.sendBladeHeight(options.bladeHeight);
    const bytes = Buffer.from(buildStartMowCommand(options, session.userAccount, context.deviceName, this.seq, context.productKey), 'base64');
    await this.sendRaw(bytes, 'start_mowing');
  }

  /** Sends a pre-built raw command, then reflects the new value on the given capability. */
  private async sendCommandAndSync(
    commandB64: string,
    label: string,
    capability: string,
    value: number | string | boolean,
  ): Promise<void> {
    await this.sendRaw(Buffer.from(commandB64, 'base64'), label);
    this.setCapIfChanged(capability, value);
  }

  /** Sets the mower's cutting speed mode (Low/Medium/High) and reflects it on mow_cutter_mode. */
  async actionSetBladeSpeed(mode: 'economic' | 'standard' | 'performance'): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetBladeSpeedCommand(CUTTER_MODE_MAP[mode], session.userAccount, this.seq);
    await this.sendCommandAndSync(cmd, `set_blade_speed(${mode})`, 'mow_cutter_mode', mode);
  }

  private static readonly POS_LEVEL_MAP: Record<number, string> = { 1: 'gnss', 2: 'float', 4: 'rtk' };
  private static posLevelToEnum(level: number): string {
    return LubaDevice.POS_LEVEL_MAP[level] ?? 'none';
  }

  /** Toggles rain protection (stop mowing in rain vs. continue) and reflects it on mow_rain_protection. */
  async actionSetRainProtection(enabled: boolean): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetRainProtectionCommand(enabled, session.userAccount, this.seq);
    await this.sendCommandAndSync(cmd, `set_rain_protection(${enabled})`, 'mow_rain_protection', enabled);
  }

  /** setIds: 0 = headlamp, 1 = side LED */
  private static readonly LAMP_TARGETS: Record<0 | 1, { label: string; capability: string }> = {
    0: { label: 'headlamp', capability: 'mow_headlamp' },
    1: { label: 'side_led', capability: 'mow_side_led' },
  };

  /** Toggles the headlamp (setIds=0) or side LED (setIds=1) and reflects it on the matching capability. */
  async actionSetHeadlamp(on: boolean, setIds: 0 | 1): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetHeadlampCommand(on, session.userAccount, this.seq, setIds);
    const target = LubaDevice.LAMP_TARGETS[setIds];
    await this.sendCommandAndSync(cmd, `set_${target.label}(${on})`, target.capability, on);
  }

  /** Sends the mower back to its charging dock. */
  async actionDock(): Promise<void> { await this.sendTaskControlRaw('dock'); }
  /** Pauses the current mowing job. */
  async actionPause(): Promise<void> { await this.sendTaskControlRaw('pause'); }
  /** Cancels/ends the current mowing job. */
  async actionStop(): Promise<void> { await this.sendTaskControlRaw('stop'); }

  /** Builds and sends a NavTaskCtrl command for the given task-control action. */
  private async sendTaskControlRaw(command: 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock'): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const bytes = Buffer.from(buildTaskControlCommand(command, session.userAccount, context.deviceName, this.seq, context.productKey), 'base64');
    await this.sendRaw(bytes, command);
  }

  /** Sends a set-blade-height command. */
  private async sendBladeHeight(heightMm: number): Promise<void> {
    const session = await this.getSession();
    const bytes = Buffer.from(buildSetBladeHeightCommand(heightMm, session.userAccount, this.seq), 'base64');
    await this.sendRaw(bytes, 'set_blade_height');
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /** Stops timers and disconnects all transports. */
  private cleanup(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.mqttReconnectTimer) { clearTimeout(this.mqttReconnectTimer); this.mqttReconnectTimer = null; }
    this.mqtt?.disconnect();
    this.mqtt = null;
    void this.ble?.disconnect();
    this.ble = null;
    // Only unregisters this device from the driver's SHARED connection — never tears down
    // the connection itself, since other legacy devices on the account may still need it.
    if (this.getContext()?.transportKind === 'aliyun_legacy') {
      (this.driver as unknown as LubaDriver).unregisterAliyunDevice(this.getData().id as string);
    }
    this.activeTransport = 'none';
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /** Returns the last known mower status, used by the is_mowing Flow condition. */
  getMowerState(): MowerStatus { return this.currentStatus; }
  /** Reads the device's cloud context (productKey, deviceName, iotId) from the store. */
  private getContext(): DeviceContext { return this.getStoreValue('context') as DeviceContext; }
  /** Delegates to the driver for a valid (refreshed if needed) auth session. */
  private async getSession(): Promise<AuthSession> {
    return (this.driver as any).getValidSession() as Promise<AuthSession>;
  }
}
