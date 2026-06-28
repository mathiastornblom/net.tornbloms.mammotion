'use strict';

import Homey from 'homey';
import type { DeviceContext, AuthSession } from '../../lib/mammotion/auth/types';
import { MqttClient, type TelemetryState } from '../../lib/mammotion/mqtt/MqttClient';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth';
import {
  buildTaskControlCommand,
  buildStartMowCommand,
  buildRequestIotSyncCommand,
  buildTaskSettingsCommand,
  type StartMowOptions,
} from '../../lib/mammotion/commands/LubaCommands';
import { WORK_MODE } from '../../lib/mammotion/constants';
import { MammotionError } from '../../lib/mammotion/errors';

type MowerStatus = 'idle' | 'mowing' | 'returning' | 'charging' | 'paused' | 'error';

const TELEMETRY_POLL_INTERVAL_MS = 30_000;
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
 * It owns its slice of the shared MqttClient and handles all capability reads/writes.
 */
module.exports = class LubaDevice extends Homey.Device {

  private mqtt: MqttClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private seq = { value: 0 };
  private currentStatus: MowerStatus = 'idle';

  async onInit(): Promise<void> {
    this.log(`LubaDevice ${this.getName()} initializing`);

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (value) {
        await this.actionStartMowing({});
      } else {
        await this.actionDock();
      }
    });

    this.registerCapabilityListener('mow_blade_height', async (value: number) => {
      await this.sendBladeHeight(value);
    });

    await this.connectMqtt();
    this.startPollTimer();
  }

  async onDeleted(): Promise<void> {
    this.cleanup();
  }

  async onUninit(): Promise<void> {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.mqtt?.disconnect();
    this.mqtt = null;
  }

  private async connectMqtt(): Promise<void> {
    try {
      const session = await this.getSession();
      const [devices, records] = await Promise.all([
        MammotionAuth.fetchDevices(session),
        MammotionAuth.fetchDeviceRecords(session),
      ]);

      const recordsByIotId = new Map(records.map(r => [r.iotId, r]));
      const contexts = devices.map(d => MammotionAuth.mergeDeviceContext(d, recordsByIotId.get(d.iotId) ?? d as any));

      const mqttCreds = await MammotionAuth.fetchMqttCredentials(session);

      this.mqtt = new MqttClient({
        onTelemetry: (iotId, state) => this.handleTelemetry(iotId, state),
        onStatus: (iotId, online) => this.handleStatus(iotId, online),
        log: (msg) => this.log(msg),
        logError: (msg) => this.error(msg),
      });

      this.mqtt.connect(mqttCreds, contexts);

      setTimeout(() => void this.requestSync(), SYNC_ON_CONNECT_DELAY_MS);
    } catch (err) {
      this.error(`MQTT connect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildRequestIotSyncCommand(session.userAccount, false, this.seq);
    await this.mqtt?.sendCommand(session, context, cmd);
  }

  private handleTelemetry(iotId: string, state: Partial<TelemetryState>): void {
    if (iotId !== this.getData().id) return;

    if (state.batteryPercent !== undefined && state.batteryPercent !== null) {
      this.setCapabilityValue('measure_battery', state.batteryPercent).catch(this.error.bind(this));
    }
    if (state.workMode !== undefined && state.workMode !== null) {
      const status = workModeToStatus(state.workMode);
      this.updateMowerStatus(status, state.workMode);
    }
    if (state.progress !== undefined && state.progress !== null) {
      this.setCapabilityValue('measure_mow_progress', state.progress).catch(this.error.bind(this));
    }
    if (state.area !== undefined && state.area !== null) {
      this.setCapabilityValue('measure_mow_area', state.area).catch(this.error.bind(this));
    }
    if (state.bladeHeight !== undefined && state.bladeHeight !== null) {
      this.setCapabilityValue('mow_blade_height', state.bladeHeight).catch(this.error.bind(this));
    }
  }

  private handleStatus(iotId: string, online: boolean): void {
    if (iotId !== this.getData().id) return;
    this.setAvailable().catch(this.error.bind(this));
    if (!online) this.setUnavailable(this.homey.__('error.device_offline')).catch(this.error.bind(this));
  }

  private updateMowerStatus(status: MowerStatus, rawMode: number): void {
    const wasStatus = this.currentStatus;
    this.currentStatus = status;

    this.setCapabilityValue('mower_status', status).catch(this.error.bind(this));
    this.setCapabilityValue('onoff', status === 'mowing').catch(this.error.bind(this));
    this.setCapabilityValue('alarm_generic', isErrorMode(rawMode)).catch(this.error.bind(this));

    // Fire Flow triggers on state transitions
    if (wasStatus !== 'mowing' && status === 'mowing') {
      this.driver.emit('mower_started_mowing', this);
    } else if (wasStatus !== 'charging' && status === 'charging') {
      this.driver.emit('mower_docked', this);
    } else if (status === 'error') {
      this.driver.emit('mower_error', this);
    }
  }

  // ─── Public command methods (called from driver flow cards) ──────────────────

  async actionStartMowing(options: StartMowOptions): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildStartMowCommand(options, session.userAccount, context.deviceName, this.seq);
    await this.sendWithTimeout(session, context, cmd, 'start_mowing');
  }

  async actionDock(): Promise<void> {
    await this.sendTaskControl('dock');
  }

  async actionPause(): Promise<void> {
    await this.sendTaskControl('pause');
  }

  async actionStop(): Promise<void> {
    await this.sendTaskControl('stop');
  }

  private async sendTaskControl(command: 'start' | 'pause' | 'resume' | 'stop' | 'dock' | 'cancelJob' | 'cancelDock'): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildTaskControlCommand(command, session.userAccount, context.deviceName, this.seq);
    await this.sendWithTimeout(session, context, cmd, command);
  }

  private async sendBladeHeight(heightMm: number): Promise<void> {
    const session = await this.getSession();
    const context = this.getContext();
    const cmd = buildTaskSettingsCommand(heightMm, 0.3, session.userAccount, this.seq);
    await this.sendWithTimeout(session, context, cmd, 'set_blade_height');
  }

  private async sendWithTimeout(
    session: AuthSession,
    context: DeviceContext,
    contentBase64: string,
    label: string,
  ): Promise<void> {
    if (!this.mqtt) throw new MammotionError('MQTT not connected');
    const result = await Promise.race([
      this.mqtt.sendCommand(session, context, contentBase64),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Command timeout: ${label}`)), 10_000)),
    ]);
    this.log(`Command ${label} response: ${String(result).substring(0, 100)}`);
  }

  getMowerState(): MowerStatus {
    return this.currentStatus;
  }

  private getContext(): DeviceContext {
    return this.getStoreValue('context') as DeviceContext;
  }

  private async getSession(): Promise<AuthSession> {
    return (this.driver as any).getValidSession() as Promise<AuthSession>;
  }
};
