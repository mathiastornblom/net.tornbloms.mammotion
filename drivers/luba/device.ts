
import Homey from 'homey';
import type { DeviceContext, AuthSession } from '../../lib/mammotion/auth/types.js';
import { MqttClient, type TelemetryState } from '../../lib/mammotion/mqtt/MqttClient.js';
import { BleTransport } from '../../lib/mammotion/ble/BleTransport.js';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth.js';
import { extractTelemetry } from '../../lib/mammotion/protocol/TelemetryParser.js';
import { workModeToStatus, isErrorMode, type MowerStatus } from '../../lib/mammotion/protocol/WorkModeStatus.js';
import { MOWING_ACTIVE_WORK_MODES } from '../../lib/mammotion/constants.js';
import { extractSchedule, type ScheduleInfo } from '../../lib/mammotion/protocol/ScheduleParser.js';
import { extractErrorCode, extractUpdateBuf, extractRainProtection } from '../../lib/mammotion/protocol/ErrorCodeParser.js';
import {
  buildTaskControlCommand,
  buildStartMowCommand,
  buildRequestIotSyncCommand,
  buildSetBladeHeightCommand,
  buildSetBladeSpeedCommand,
  buildSetHeadlampCommand,
  buildSetSideLedCommand,
  buildSetRainProtectionCommand,
  buildReadRainProtectionCommand,
  buildReadScheduleCommand,
  CUTTER_MODE_MAP,
  type StartMowOptions,
} from '../../lib/mammotion/commands/LubaCommands.js';
import {
  MammotionError, AliyunCommandError, DeviceOfflineError, AliyunCircuitOpenError, AliyunCredentialsRefreshError,
} from '../../lib/mammotion/errors.js';
import { errorMessage } from '../../lib/util/errorMessage.js';
import { sendAliyunCloudCommand } from '../../lib/mammotion/aliyun/commands.js';
import {
  DeviceType, resolveDeviceType, capabilitiesForModel, MODEL_STRING,
} from '../../lib/mammotion/deviceType.js';
import LubaDriver from './driver.js';

type TransportName = 'ble' | 'mqtt' | 'aliyun_legacy' | 'none';
type TransportPreference = 'auto' | 'ble_only' | 'mqtt_only';

// Re-arm the one-shot report subscription every 5s, matching Mammotion-HA.
const TELEMETRY_POLL_INTERVAL_MS = 5_000;
// A real diagnostic report (2026-07-13, Yuka) showed every start_mowing command being sent
// twice, ~100-260ms apart, every single time the mower was started across the whole session
// — both dispatches got distinct successful responses, and the mower stopped after ~1m
// reporting the job "finished" instead of actually mowing. actionStartMowing() is reachable
// from two legitimate entry points (the onoff capability listener and the start_mowing Flow
// action card), so a duplicate at this exact cadence is consistent with something upstream
// (a Flow chaining both, or a platform-level double-dispatch) invoking both — but regardless
// of which one, the mower's own firmware very plausibly can't distinguish "the same start
// requested twice in a row" from "start, then immediately cancel/re-evaluate", which would
// explain the reported behavior. Guards the same *label* from firing twice within this
// window, at sendRaw() — the one chokepoint every outgoing command already passes through.
const DUPLICATE_COMMAND_WINDOW_MS = 1_500;
const SYNC_ON_CONNECT_DELAY_MS = 2_000;
// Once the mower has confirmed itself offline (DeviceOfflineError, not just a transient
// send failure), polling every 5s indefinitely is wasted cloud traffic for a mower that
// could be powered off for a while — back off, but cap low (60s, matching
// scheduleMqttReconnect's own cap below) rather than minutes: a user coming home and
// switching the mower back on expects Homey to notice within well under a minute, not
// however long a looser cap would allow.
const OFFLINE_POLL_BASE_MS = 10_000;
const OFFLINE_POLL_MAX_MS = 60_000; // 1 min

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
  /** Last command label + timestamp sent via sendRaw() — drives the duplicate-command guard
   *  there (see its doc comment for why this exists). */
  private lastCommandSent: { label: string; at: number } | null = null;
  private currentStatus: MowerStatus = 'idle';
  /** Last logged sensorStatusRaw/selfCheckStatusRaw values — diagnostic change-gating only,
   *  for the two fault-code candidate fields (see TelemetryParser.ts). */
  private lastSensorStatusRaw: number | null = null;
  private lastSelfCheckStatusRaw: number | null = null;
  /** Last logged sysTimeStampRaw value — diagnostic change-gating, see TelemetryParser.ts. */
  private lastSysTimeStampRaw: number | null = null;

  // ─── Init / teardown ─────────────────────────────────────────────────────

  /** Registers capability listeners and starts BLE/MQTT transports per the device's transport_preference setting. */
  async onInit(): Promise<void> {
    this.log(`LubaDevice ${this.getName()} initializing (preference=${this.transportPreference()})`);

    await this.migrateCapabilities();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await (value ? this.actionStartMowing({}) : this.actionDock());
    });

    this.registerCapabilityListener('mow_blade_height', async (value: number) => {
      await this.sendBladeHeight(value);
    });

    this.registerCapabilityListener('mow_cutter_mode', async (value: string) => {
      await this.actionSetBladeSpeed(value as 'economic' | 'standard' | 'performance');
    });

    // Guarded — mow_headlamp is model-gated by migrateCapabilities() (absent on non-mower
    // device types like RTK base stations) and Homey errors if you register a listener for a
    // capability the device lacks.
    if (this.hasCapability('mow_headlamp')) {
      this.registerCapabilityListener('mow_headlamp', async (value: boolean) => {
        await this.actionSetHeadlamp(value);
      });
    }

    this.registerCapabilityListener('mow_side_led', async (value: boolean) => {
      await this.actionSetSideLed(value);
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

  /** Reconciles this device's actual capabilities against the model-appropriate set
   *  (docs/CAPABILITY_DIFFERENTIATION_PLAN.md), adding anything missing and removing anything
   *  the model doesn't actually have (e.g. mow_headlamp on an RTK base station, which has no
   *  headlamp). Homey only applies a driver's capabilities list at pairing time — adding (or
   *  gating) a capability in the manifest/pairing-time list does nothing for devices paired on
   *  an older app version, so this needs to run on every init to actually reach existing users
   *  (confirmed via a real user report, 2026-07-05: last_sync never appeared after updating to
   *  v2.5.16 on an already-paired device). Safe to run every time — add/removeCapability are
   *  no-ops when the device already matches the target state. */
  private async migrateCapabilities(): Promise<void> {
    const context = this.getContext();
    const deviceType = resolveDeviceType(context.deviceName, context.productKey);
    const pairingCapabilities = (this.driver as unknown as LubaDriver).pairingCapabilities;
    const expected = new Set(capabilitiesForModel(pairingCapabilities, deviceType));

    for (const capability of pairingCapabilities) {
      const shouldHave = expected.has(capability);
      const hasIt = this.hasCapability(capability);
      if (shouldHave && !hasIt) {
        this.log(`Migrating: adding capability ${capability} (model=${MODEL_STRING[deviceType]})`);
        await this.addCapability(capability).catch(this.error.bind(this));
      } else if (!shouldHave && hasIt) {
        this.log(`Migrating: removing capability ${capability} — not supported on model ${MODEL_STRING[deviceType]}`);
        await this.removeCapability(capability).catch(this.error.bind(this));
      }
    }
  }

  /** Called by the driver after a successful Repair — retries with fresh cloud session. */
  async retryAfterRepair(): Promise<void> {
    // cleanup() first, matching onSettings()'s transport-preference-change path — without
    // it, this ran startTransports() on top of whatever was already running: a second
    // BleTransport left the old one's scan/reconnect loop orphaned (duplicating every BLE
    // scan and reconnect log line forever), and a second poll-timer chain doubled the
    // Aliyun requestSync cadence — both writing the same shared this.offlinePollFailureCount,
    // so its backoff thrashed instead of climbing cleanly. Together this doubled Aliyun
    // traffic (worsening the very rate-limiting the backoff exists to avoid) and produced
    // the rapid-fire, contradictory telemetry a real user (Anders) reported as "many status
    // updates in a short time" for a mower that was actually just sitting in its dock the
    // whole time (diagnostic log f428f48b-189a-41ce-8ddc-05d0a949a4f3, 2026-07-08).
    this.cleanup();
    this.mqttFailureCount = 0;
    this.offlinePollFailureCount = 0;
    if (this.getContext().transportKind === 'aliyun_legacy') {
      // A stuck-open circuit breaker previously survived Repair entirely (only a full app
      // restart cleared it — see LubaDriver.resetAliyunConnection()'s doc comment for the
      // real diagnostic report). Repair is the user's manual recovery action, so it should
      // actually be able to recover from this.
      (this.driver as unknown as LubaDriver).resetAliyunConnection();
    }
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
    if (this.homey.settings.get('debugLogging') === true) {
      this.log(`[debug] received: ${JSON.stringify(msg)}`);
    }
    const schedule = extractSchedule(msg);
    if (schedule) this.handleScheduleResponse(schedule);
    const errorCode = extractErrorCode(msg);
    if (errorCode !== null) this.handleErrorCodeMessage(errorCode);
    const updateBuf = extractUpdateBuf(msg);
    if (updateBuf !== null) this.handleUpdateBufMessage(updateBuf);
    const rainProtection = extractRainProtection(msg);
    if (rainProtection !== null) this.setCapIfChanged('mow_rain_protection', rainProtection);
  }

  /** Diagnostic-only: logs a device-pushed fault code (MctlSys.toapp_err_code — see
   *  ErrorCodeParser.ts), a distinct one-shot message from the periodic telemetry report.
   *  Not yet wired to alarm_generic/mower_error — the numeric code_no → fault meaning
   *  table (e.g. wheel-lift/emergency-stop) isn't confirmed against a real device, so this
   *  just surfaces the raw value until a real fault event's log data can map it. */
  private handleErrorCodeMessage(code: number): void {
    this.log(`[error_code] device reported errorCode=${code}`);
  }

  /** Diagnostic-only: logs MctlSys.systemUpdateBuf's raw contents (see
   *  ErrorCodeParser.ts's extractUpdateBuf) — a completely undecoded message until now,
   *  and the last untried candidate channel for a wheel-lift/emergency-stop fault code
   *  after sys_status, sensor_status, self_check_status, and toapp_err_code all showed
   *  nothing during a real, live-reported emergency stop (diagnostic log
   *  a66d2bc3-4572-41d1-b8ba-cbc82b05d658, 2026-07-09). Logs the whole array unconditionally
   *  so a real capture can tell us empirically what this device class actually sends here. */
  private handleUpdateBufMessage(data: number[]): void {
    this.log(`[update_buf] device reported systemUpdateBuf=[${data.join(',')}]`);
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
        throw new Error(`getSession: ${errorMessage(err)}`);
      });
      this.log(`cloud session OK (iotDomain=${session.iotDomain}, userAccount=${session.userAccount})`);

      const [devices, recordsResult] = await Promise.all([
        MammotionAuth.fetchDevices(session).catch((err) => { throw new Error(`fetchDevices: ${errorMessage(err)}`); }),
        MammotionAuth.fetchDeviceRecords(session).catch((err) => { throw new Error(`fetchDeviceRecords: ${errorMessage(err)}`); }),
      ]);
      const records = recordsResult.records;

      const ownedByIotId = new Map(devices.map(d => [d.iotId, d]));
      const contexts = records.map(r => MammotionAuth.mergeDeviceContext(ownedByIotId.get(r.iotId) ?? {}, r));
      const thisContext = contexts.find(c => c.iotId === this.getData().id);
      this.log(`devices fetched: owned=${devices.length} records=${records.length}; `
        + `this device: ${thisContext ? `productKey=${thisContext.productKey} name=${thisContext.recordDeviceName}` : 'NOT FOUND in records'}`);

      const mqttCreds = await MammotionAuth.fetchMqttCredentials(session).catch((err) => {
        throw new Error(`fetchMqttCredentials: ${errorMessage(err)}`);
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
          this.error(`Initial sync failed: ${errorMessage(err)}`);
        });
        this.requestRainProtectionState().catch((err) => {
          this.error(`Initial rain-protection state read failed: ${errorMessage(err)}`);
        });
      }, SYNC_ON_CONNECT_DELAY_MS);

    } catch (err) {
      const message = errorMessage(err);
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
      this.error(`[Aliyun] registerAliyunDevice failed: ${errorMessage(err)}`);
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
   *  DeviceOfflineError, an AliyunCommandError(429) (rate-limited by the Aliyun gateway — see
   *  sendAliyunCloudCommand), an AliyunCircuitOpenError (the legacy Aliyun handshake's circuit
   *  breaker, AliyunCredentialsManager, fast-failing without a network call), or an
   *  AliyunCredentialsRefreshError (a *real* handshake attempt that failed, e.g. getRegion
   *  returning HTTP 500 — the 1-2 attempts every outage/re-open cycle makes *before* the
   *  circuit breaker's failure count reaches its limit and starts fast-failing) all back off
   *  exponentially (OFFLINE_POLL_BASE_MS → _MAX_MS, same backoff shape as BleTransport) instead
   *  of hammering at full 5s cadence for a mower that could be powered off for hours, or worse,
   *  retrying a doomed operation at full speed forever (a real diagnostic report showed exactly
   *  this for a 429: requestSync every 5s for 15+ minutes straight, 2026-07-05).
   *  AliyunCircuitOpenError was fixed for this in v2.5.33 (2026-07-09, "no updates for days"),
   *  but a follow-up report the next day (2026-07-10) showed the *pre-circuit-open* attempts
   *  during the same kind of outage still hammering at full 5s cadence — this closes that
   *  residual gap so an entire Aliyun outage backs off end to end, not just the portion the
   *  circuit breaker has already given up on. Any other outcome (success, or a different error,
   *  which is likely transient) keeps the normal fast cadence. */
  private async runPollTick(): Promise<void> {
    try {
      await this.requestSync();
      this.offlinePollFailureCount = 0;
      this.schedulePoll(TELEMETRY_POLL_INTERVAL_MS);
    } catch (err) {
      const isRateLimited = err instanceof AliyunCommandError && err.code === 429;
      const isAliyunUnreachable = err instanceof AliyunCircuitOpenError || err instanceof AliyunCredentialsRefreshError;
      if (err instanceof DeviceOfflineError || isRateLimited || isAliyunUnreachable) {
        this.offlinePollFailureCount += 1;
        const delay = Math.min(OFFLINE_POLL_BASE_MS * (2 ** this.offlinePollFailureCount), OFFLINE_POLL_MAX_MS);
        const reason = isRateLimited
          ? 'rate-limited by Aliyun'
          : isAliyunUnreachable ? 'Aliyun cloud unreachable' : 'mower still offline';
        this.log(`Poll: ${reason} — next check in ${Math.round(delay / 1000)}s (failure #${this.offlinePollFailureCount})`);
        this.schedulePoll(delay);
      } else {
        this.error(`Poll sync failed: ${errorMessage(err)}`);
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

  /** Writes a capability value only if it differs from the current one, to avoid redundant
   *  Homey updates. Silently no-ops for a capability this device doesn't have — per-model
   *  capability gating (see lib/mammotion/deviceType.ts) removes capabilities like
   *  measure_battery_cycles from models that don't support them, but incoming telemetry
   *  still carries a value for every field regardless of model. getCapabilityValue() throws
   *  synchronously ("Invalid Capability: X") for a missing capability — uncaught, that threw
   *  partway through handleTelemetry() and silently dropped every telemetry field that
   *  would've been processed after it in the same message (real diagnostic report,
   *  2026-07-06, on a gated-out measure_battery_cycles). */
  private setCapIfChanged(capability: string, value: number | string | boolean): boolean {
    if (!this.hasCapability(capability)) return false;
    if (this.getCapabilityValue(capability) === value) return false;
    this.setCapabilityValue(capability, value).catch(this.error.bind(this));
    return true;
  }

  /** Formats "now" in the Homey hub's own timezone as an unambiguous "YYYY-MM-DD HH:MM:SS"
   *  string — sv-SE locale formatting conveniently produces that shape without hand-rolling
   *  date arithmetic. Used for the last_sync diagnostic capability, so users can tell fresh
   *  telemetry from stale data sitting on screen during a transport outage or cloud backoff
   *  (e.g. the Aliyun 429 loop this capability was added alongside) instead of assuming the
   *  displayed battery/status is live right now. */
  private formatNowForLastSync(): string {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.homey.clock.getTimezone(),
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());
  }

  /** Applies a decoded telemetry update to Homey capabilities and fires Flow triggers as needed. */
  private handleTelemetry(iotId: string, state: Partial<TelemetryState>, via: TransportName): void {
    if (iotId !== this.getData().id) return;
    this.mqttFailureCount = 0;
    this.setCapIfChanged('last_sync', this.formatNowForLastSync());

    const changed: string[] = [];

    if (state.batteryPercent != null) {
      if (this.setCapIfChanged('measure_battery', state.batteryPercent)) {
        changed.push(`battery=${state.batteryPercent}`);
        (this.driver as unknown as LubaDriver).triggerBatteryBelow(this, state.batteryPercent);
      }
    }
    if (state.workMode != null) {
      const status = workModeToStatus(state.workMode, state.chargeState ?? null);
      if (status !== this.currentStatus) changed.push(`status=${status}(${state.workMode},charge=${state.chargeState ?? 'n/a'})`);
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
      // bladeUsedTime is in SECONDS (see TelemetryParser.ts) — expose as hours with 1
      // decimal. Previously divided by 60 as if the wire value were minutes, overstating
      // real blade usage by 60x on every device (confirmed via a real diagnostic report,
      // 2026-07-04: reported 3241.5 "hours" for a mower active since October 2025 — the
      // correct value, dividing by 3600, is ~54 hours).
      const hours = Math.round(state.bladeUsedTime / 360) / 10;
      if (this.setCapIfChanged('measure_blade_used_time', hours)) changed.push(`blade=${hours}h`);
    }
    if (state.mileage != null) {
      // mileage is in METRES (lifetime distance) — see TelemetryParser.ts. Exposed in km
      // with 1 decimal, matching how measure_mow_area/other measures round for display.
      const km = Math.round(state.mileage / 100) / 10;
      if (this.setCapIfChanged('measure_total_distance', km)) changed.push(`distance=${km}km`);
    }
    if (state.workTime != null) {
      // workTime is in SECONDS (lifetime work time) — see TelemetryParser.ts.
      const hours = Math.round(state.workTime / 360) / 10;
      if (this.setCapIfChanged('measure_total_work_time', hours)) changed.push(`worktime=${hours}h`);
    }
    // rpt_dev_status.headlamp_status is a plain on/off flag for the main headlamp — confirmed
    // via a real diagnostic report (2026-07-14, Luba 3) showing it flip 0->1->0 in lockstep
    // with our own set_headlamp(true)/set_headlamp(false) commands, AND flip on its own
    // (matching a manual toggle from the official app) with no Homey-sent command involved.
    // Reflecting it here is what makes an iOS-app-initiated toggle show up in Homey too —
    // previously this was logged as a diagnostic value and never written to the capability,
    // so mow_headlamp only ever changed when Homey itself sent the command. No equivalent
    // raw field has been observed for the side LED yet, so mow_side_led stays write-only.
    if (state.headlampStatusRaw != null && this.hasCapability('mow_headlamp')
      && this.setCapIfChanged('mow_headlamp', state.headlampStatusRaw !== 0)) {
      changed.push(`headlamp=${state.headlampStatusRaw !== 0}`);
    }
    // Raw value kept for diagnostics — sensor_status also carries four ultrasonic-sensor
    // sub-fields (bits 12-23) this app doesn't decode yet. The bumper/blade sub-fields
    // below ARE confirmed decodes (see TelemetryParser.ts's decodeBumperState/
    // decodeBladeActive) and are real capabilities, not diagnostic-only.
    if (state.sensorStatusRaw != null && state.sensorStatusRaw !== this.lastSensorStatusRaw) {
      this.lastSensorStatusRaw = state.sensorStatusRaw;
      changed.push(`sensorStatusRaw=${state.sensorStatusRaw}`);
    }
    if (state.bumperState != null && this.setCapIfChanged('mow_bumper_state', state.bumperState)) {
      changed.push(`bumper=${state.bumperState}`);
    }
    if (state.bladeActive != null && this.setCapIfChanged('mow_blade_active', state.bladeActive)) {
      changed.push(`bladeActive=${state.bladeActive}`);
    }
    // Diagnostic-only — self_check_status has no interpretation anywhere in Mammotion-HA/
    // pymammotion at all (unlike sensor_status above). See
    // docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md.
    if (state.selfCheckStatusRaw != null && state.selfCheckStatusRaw !== this.lastSelfCheckStatusRaw) {
      this.lastSelfCheckStatusRaw = state.selfCheckStatusRaw;
      changed.push(`selfCheckStatusRaw=${state.selfCheckStatusRaw} [diagnostic, not yet mapped]`);
    }
    // Diagnostic-only: testing a real hypothesis (2026-07-09) that rapid mowing/charging
    // status flip-flops reported under heavy Aliyun rate-limiting are stale/out-of-order
    // buffered reports, not a real physical oscillation. Units are unconfirmed, so log both
    // plausible epoch interpretations' skew from receipt time — whichever is small/sane
    // during normal operation tells us the real unit, and a large lag during a flapping
    // episode would confirm the staleness theory.
    if (state.sysTimeStampRaw != null && state.sysTimeStampRaw !== this.lastSysTimeStampRaw) {
      this.lastSysTimeStampRaw = state.sysTimeStampRaw;
      const now = Date.now();
      const skewIfSeconds = Math.round(now / 1000 - state.sysTimeStampRaw);
      const skewIfMs = Math.round(now - state.sysTimeStampRaw);
      changed.push(`sysTimeStampRaw=${state.sysTimeStampRaw} [diagnostic; skewIfSeconds=${skewIfSeconds}s skewIfMs=${skewIfMs}ms]`);
    }

    if (changed.length > 0) this.log(`[${via}] telemetry changed: ${changed.join(' ')}`);
  }

  /** Updates the mower_status/onoff/alarm_generic capabilities and fires the matching Flow trigger on transition. */
  private updateMowerStatus(status: MowerStatus, rawMode: number): void {
    const wasStatus = this.currentStatus;
    this.currentStatus = status;

    this.setCapIfChanged('mower_status', status);
    // onoff reflects "is a job currently running" (matching MOWING_ACTIVE_WORK_MODES), not
    // narrowly "is it cutting grass right now" — a mower returning to dock or paused mid-job
    // hasn't finished the job. Previously tied to `status === 'mowing'` only, which flipped
    // onoff off for every 'returning'/'paused' report even during completely normal job
    // behavior; see that constant's header comment for the real diagnostic report this fixes.
    this.setCapIfChanged('onoff', MOWING_ACTIVE_WORK_MODES.includes(rawMode));
    this.setCapIfChanged('alarm_generic', isErrorMode(rawMode));

    if (status === wasStatus) return;
    const driver = this.driver as unknown as LubaDriver;
    driver.triggerMowerStatusChanged(this, status);
    if (status === 'mowing') driver.triggerMowerStartedMowing(this);
    else if (status === 'returning') driver.triggerMowerStartedReturning(this);
    else if (status === 'charging') driver.triggerMowerDocked(this);
    else if (status === 'error') driver.triggerMowerError(this);
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  /** Choose which transport to route a raw-bytes command through. BLE is tried first
   *  whenever it's actually connected, regardless of transportKind — it's local and
   *  protocol-identical either way. Below that, branch by transportKind: legacy-Aliyun
   *  devices send via the REST invoke gateway (independent of the shared MQTT connection's
   *  status — sending doesn't need the read/telemetry connection up), everything else uses
   *  the primary Mammotion MQTT client.
   *
   *  Guards against sending the exact same command label twice within
   *  DUPLICATE_COMMAND_WINDOW_MS — see that constant's doc comment for the real diagnostic
   *  report this fixes. Each command already carries its own incrementing seq number (see
   *  envelope() in LubaCommands.ts), so a genuine duplicate dispatch isn't byte-identical —
   *  this compares by label instead, which captures the semantic action regardless. */
  private async sendRaw(bytes: Buffer, label: string): Promise<void> {
    const now = Date.now();
    if (this.lastCommandSent?.label === label && now - this.lastCommandSent.at < DUPLICATE_COMMAND_WINDOW_MS) {
      this.log(`Skipping duplicate ${label} command sent ${now - this.lastCommandSent.at}ms after the previous one`);
      return;
    }
    this.lastCommandSent = { label, at: now };
    if (this.homey.settings.get('debugLogging') === true) {
      this.log(`[debug] sending ${label}: ${bytes.toString('base64')}`);
    }
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

  /** Sends a pre-built raw command, then reflects the new value on the given capability. On
   *  failure, logs the resolved model/deviceType alongside the error — capability gating
   *  (docs/CAPABILITY_DIFFERENTIATION_PLAN.md) is based on device-type class, not the
   *  individual physical unit, so a command that fails or silently no-ops for a reason tied to
   *  real hardware variance within a class (e.g. an older firmware revision not supporting a
   *  given command) needs this context captured to ever close that gap. */
  private async sendCommandAndSync(
    commandB64: string,
    label: string,
    capability: string,
    value: number | string | boolean,
  ): Promise<void> {
    try {
      await this.sendRaw(Buffer.from(commandB64, 'base64'), label);
    } catch (err) {
      const context = this.getContext();
      const deviceType = resolveDeviceType(context.deviceName, context.productKey);
      this.error(
        `Command ${label} (capability=${capability}) failed on model=${MODEL_STRING[deviceType]} `
        + `(deviceType=${DeviceType[deviceType]}, productKey=${context.productKey}, deviceName=${context.deviceName}): `
        + `${errorMessage(err)}`,
      );
      throw err;
    }
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

  /** Toggles rain protection (auto-stop mowing when rain is detected) and reflects it on
   *  mow_rain_protection. The device also echoes this state back independently (see
   *  extractRainProtection) so it stays in sync if changed from the official app instead. */
  async actionSetRainProtection(enabled: boolean): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetRainProtectionCommand(enabled, session.userAccount, this.seq);
    await this.sendCommandAndSync(cmd, `set_rain_protection(${enabled})`, 'mow_rain_protection', enabled);
  }

  /** Requests the mower's current rain-protection state; the reply is picked up by
   *  handleRawMessage/extractRainProtection and reflected on mow_rain_protection. */
  private async requestRainProtectionState(): Promise<void> {
    const session = await this.getSession();
    const cmd = buildReadRainProtectionCommand(session.userAccount, this.seq);
    await this.sendRaw(Buffer.from(cmd, 'base64'), 'read_rain_protection');
  }

  /** Toggles the main headlamp (SocMul.set_lamp, manual on/off) and reflects it on mow_headlamp. */
  async actionSetHeadlamp(on: boolean): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetHeadlampCommand(on, session.userAccount, this.seq);
    await this.sendCommandAndSync(cmd, `set_headlamp(${on})`, 'mow_headlamp', on);
  }

  /** Toggles the side LED (MctlSys.todev_time_ctrl_light) and reflects it on mow_side_led. */
  async actionSetSideLed(on: boolean): Promise<void> {
    const session = await this.getSession();
    const cmd = buildSetSideLedCommand(on, session.userAccount, this.seq);
    await this.sendCommandAndSync(cmd, `set_side_led(${on})`, 'mow_side_led', on);
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
