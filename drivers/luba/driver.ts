'use strict';

import Homey from 'homey';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth';
import type { AuthSession, DeviceContext, MammotionDevice, DeviceRecord } from '../../lib/mammotion/auth/types';
import { DEVICE_TYPE_NAMES } from '../../lib/mammotion/constants';
import { AuthError } from '../../lib/mammotion/errors';

const SESSION_SETTINGS_KEY = 'mammotion_session';
const CREDENTIALS_SETTINGS_KEY = 'mammotion_credentials';

interface StoredCredentials { email: string; password: string; }

/** Each item returned from onPairListDevices to Homey. */
interface PairedDeviceResult {
  name: string;
  data: { id: string };
  store: { context: DeviceContext };
  capabilities: string[];
}

/**
 * LubaDriver manages pairing (cloud login + device discovery) and Flow card registration.
 */
module.exports = class LubaDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    this.log('LubaDriver initialized');
    this.registerFlowCards();
  }

  private registerFlowCards(): void {
    this.homey.flow.getDeviceTriggerCard('mower_started_mowing')
      .registerRunListener(() => true);

    this.homey.flow.getDeviceTriggerCard('mower_docked')
      .registerRunListener(() => true);

    this.homey.flow.getDeviceTriggerCard('mower_error')
      .registerRunListener(() => true);

    this.homey.flow.getActionCard('start_mowing')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionStartMowing({});
      });

    this.homey.flow.getActionCard('send_to_dock')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionDock();
      });

    this.homey.flow.getActionCard('pause_mowing')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionPause();
      });

    this.homey.flow.getConditionCard('is_mowing')
      .registerRunListener((args: { device: Homey.Device }) => {
        return (args.device as any).getMowerState() === 'mowing';
      });
  }

  /**
   * onPair is called when a pairing session starts.
   * We register handlers for the login_credentials and list_devices templates.
   */
  async onPair(session: InstanceType<typeof import('homey/lib/PairSession')>): Promise<void> {
    let pendingSession: AuthSession | null = null;

    session.setHandler('login', async (data: { username: string; password: string }) => {
      const { username, password } = data;
      if (!username || !password) throw new Error(this.homey.__('error.missing_credentials'));

      try {
        pendingSession = await MammotionAuth.login(username, password);
        await this.homey.settings.set(SESSION_SETTINGS_KEY, pendingSession);
        await this.homey.settings.set(CREDENTIALS_SETTINGS_KEY, { email: username, password } as StoredCredentials);
        this.log(`Authenticated: ${username}`);
        return true;
      } catch (err) {
        if (err instanceof AuthError) throw new Error(this.homey.__('error.invalid_credentials'));
        throw err;
      }
    });

    session.setHandler('list_devices', async (): Promise<PairedDeviceResult[]> => {
      const session = pendingSession ?? await this.getValidSession();
      const [devices, records] = await Promise.all([
        MammotionAuth.fetchDevices(session),
        MammotionAuth.fetchDeviceRecords(session),
      ]);
      return this.buildDeviceList(devices, records);
    });
  }

  /** Simple drivers that need no custom login can use this. */
  async onPairListDevices(): Promise<PairedDeviceResult[]> {
    const session = await this.getValidSession();
    const [devices, records] = await Promise.all([
      MammotionAuth.fetchDevices(session),
      MammotionAuth.fetchDeviceRecords(session),
    ]);
    return this.buildDeviceList(devices, records);
  }

  private buildDeviceList(devices: MammotionDevice[], records: DeviceRecord[]): PairedDeviceResult[] {
    const recordsByIotId = new Map<string, DeviceRecord>(records.map(r => [r.iotId, r]));
    return devices.map((device): PairedDeviceResult => {
      const record = recordsByIotId.get(device.iotId) ?? {};
      const context = MammotionAuth.mergeDeviceContext(device, record as DeviceRecord);
      return {
        name: context.deviceName || context.iotId,
        data: { id: context.iotId },
        store: { context },
        capabilities: [
          'onoff', 'measure_battery', 'alarm_generic',
          'mower_status', 'measure_mow_progress', 'measure_mow_area', 'mow_blade_height',
        ],
      };
    });
  }

  /** Retrieve a valid session, refreshing or re-logging if needed. */
  async getValidSession(): Promise<AuthSession> {
    const stored = this.homey.settings.get(SESSION_SETTINGS_KEY) as AuthSession | null;
    const creds = this.homey.settings.get(CREDENTIALS_SETTINGS_KEY) as StoredCredentials | null;
    if (!creds) throw new Error(this.homey.__('error.not_authenticated'));

    if (!stored) {
      const fresh = await MammotionAuth.login(creds.email, creds.password);
      await this.homey.settings.set(SESSION_SETTINGS_KEY, fresh);
      return fresh;
    }

    const refreshed = await MammotionAuth.ensureValidSession(stored, creds.email, creds.password);
    if (refreshed !== stored) await this.homey.settings.set(SESSION_SETTINGS_KEY, refreshed);
    return refreshed;
  }
};
