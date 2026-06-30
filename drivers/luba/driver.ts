
import Homey from 'homey';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth.js';
import type { AuthSession, DeviceContext, MammotionDevice, DeviceRecord } from '../../lib/mammotion/auth/types.js';
import { DEVICE_TYPE_NAMES } from '../../lib/mammotion/constants.js';
import { AuthError } from '../../lib/mammotion/errors.js';

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

/** Minimum satellite count for the "GPS signal is good" condition. */
const GPS_GOOD_SATELLITE_THRESHOLD = 6;

/**
 * LubaDriver manages pairing (cloud login + device discovery) and Flow card registration.
 */
export default class LubaDriver extends Homey.Driver {

  private startedMowingTrigger!: Homey.FlowCardTriggerDevice;
  private dockedTrigger!: Homey.FlowCardTriggerDevice;
  private errorTrigger!: Homey.FlowCardTriggerDevice;
  private batteryBelowTrigger!: Homey.FlowCardTriggerDevice;

  async onInit(): Promise<void> {
    this.log('LubaDriver initialized');
    this.registerFlowCards();
  }

  private registerFlowCards(): void {
    this.startedMowingTrigger = this.homey.flow.getDeviceTriggerCard('mower_started_mowing');
    this.startedMowingTrigger.registerRunListener(() => true);

    this.dockedTrigger = this.homey.flow.getDeviceTriggerCard('mower_docked');
    this.dockedTrigger.registerRunListener(() => true);

    this.errorTrigger = this.homey.flow.getDeviceTriggerCard('mower_error');
    this.errorTrigger.registerRunListener(() => true);

    this.batteryBelowTrigger = this.homey.flow.getDeviceTriggerCard('battery_below');
    this.batteryBelowTrigger.registerRunListener(
      (args: { threshold: number }, state: { battery: number }) => state.battery < args.threshold,
    );

    this.homey.flow.getActionCard('start_mowing')
      .registerRunListener(async (args: {
        device: Homey.Device;
        blade_height?: number;
        speed?: number;
        edge_mowing?: boolean;
      }) => {
        await (args.device as any).actionStartMowing({
          bladeHeight: args.blade_height,
          speed: args.speed,
          isEdge: args.edge_mowing,
        });
      });

    this.homey.flow.getActionCard('send_to_dock')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionDock();
      });

    this.homey.flow.getActionCard('pause_mowing')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionPause();
      });

    this.homey.flow.getActionCard('stop_mowing')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).actionStop();
      });

    this.homey.flow.getActionCard('read_schedule')
      .registerRunListener(async (args: { device: Homey.Device }) => {
        await (args.device as any).requestSchedule();
      });

    this.homey.flow.getConditionCard('is_mowing')
      .registerRunListener((args: { device: Homey.Device }) => {
        return (args.device as any).getMowerState() === 'mowing';
      });

    this.homey.flow.getConditionCard('battery_above')
      .registerRunListener((args: { device: Homey.Device; threshold: number }) => {
        return (args.device as any).getCapabilityValue('measure_battery') > args.threshold;
      });

    this.homey.flow.getConditionCard('gps_signal_good')
      .registerRunListener((args: { device: Homey.Device }) => {
        const stars = (args.device as any).getCapabilityValue('measure_gps_stars');
        return typeof stars === 'number' && stars >= GPS_GOOD_SATELLITE_THRESHOLD;
      });
  }

  /** Called by LubaDevice when the mower transitions into the mowing state. */
  triggerMowerStartedMowing(device: Homey.Device): void {
    this.startedMowingTrigger.trigger(device, {}, {}).catch(this.error.bind(this));
  }

  /** Called by LubaDevice when the mower transitions into the charging/docked state. */
  triggerMowerDocked(device: Homey.Device): void {
    this.dockedTrigger.trigger(device, {}, {}).catch(this.error.bind(this));
  }

  /** Called by LubaDevice when the mower reports an error work mode. */
  triggerMowerError(device: Homey.Device): void {
    this.errorTrigger.trigger(device, {}, {}).catch(this.error.bind(this));
  }

  /** Called by LubaDevice on every battery telemetry update. */
  triggerBatteryBelow(device: Homey.Device, batteryPercent: number): void {
    this.batteryBelowTrigger.trigger(device, {}, { battery: batteryPercent }).catch(this.error.bind(this));
  }

  /**
   * onPair is called when a pairing session starts.
   * We register handlers for the login_credentials and list_devices templates.
   */
  async onPair(session: Parameters<Homey.Driver['onPair']>[0]): Promise<void> {
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
        MammotionAuth.fetchDevices(session).catch((err) => {
          this.error('fetchDevices failed:', err);
          return [];
        }),
        MammotionAuth.fetchDeviceRecords(session).catch((err) => {
          this.error('fetchDeviceRecords failed:', err);
          return [];
        }),
      ]);
      this.log(`list_devices: owned=${devices.length} records=${records.length}`,
        JSON.stringify({
          owned: devices.map(d => ({ iotId: d.iotId, deviceName: d.deviceName })),
          records: records.map(r => ({ iotId: r.iotId, deviceName: r.deviceName, productKey: r.productKey })),
        }));
      return this.buildDeviceList(devices, records);
    });
  }

  /**
   * onRepair lets the user re-enter credentials (e.g. after a password change)
   * without deleting and re-adding the device — preserving its Flow associations
   * and Insights history. Reuses the same login_credentials template as onPair.
   */
  async onRepair(
    session: Parameters<Homey.Driver['onRepair']>[0],
    device: Parameters<Homey.Driver['onRepair']>[1],
  ): Promise<void> {
    session.setHandler('login', async (data: { username: string; password: string }) => {
      const { username, password } = data;
      if (!username || !password) throw new Error(this.homey.__('error.missing_credentials'));

      let fresh: AuthSession;
      try {
        fresh = await MammotionAuth.login(username, password);
      } catch (err) {
        if (err instanceof AuthError) throw new Error(this.homey.__('error.invalid_credentials'));
        throw err;
      }

      await this.homey.settings.set(SESSION_SETTINGS_KEY, fresh);
      await this.homey.settings.set(CREDENTIALS_SETTINGS_KEY, { email: username, password } as StoredCredentials);
      this.log(`Repaired with account: ${username}`);

      // The login succeeded — a failure to immediately reconnect MQTT shouldn't
      // fail the repair itself; the device's own reconnect/backoff will retry.
      (device as unknown as { retryAfterRepair(): Promise<void> })
        .retryAfterRepair()
        .catch((err: unknown) => this.error(`retryAfterRepair failed: ${err instanceof Error ? err.message : String(err)}`));

      return true;
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

  /**
   * Builds the paired-device list from the device page records, which include both
   * owned and shared devices. `devices` (the owned-only list) only backfills identifiers —
   * the owned-devices endpoint returns nothing for mowers that were shared to this account.
   */
  private buildDeviceList(devices: MammotionDevice[], records: DeviceRecord[]): PairedDeviceResult[] {
    const ownedByIotId = new Map<string, MammotionDevice>(devices.map(d => [d.iotId, d]));
    return records.map((record): PairedDeviceResult => {
      const device = ownedByIotId.get(record.iotId) ?? {};
      const context = MammotionAuth.mergeDeviceContext(device, record);
      return {
        name: context.deviceName || context.iotId,
        data: { id: context.iotId },
        store: { context },
        capabilities: [
          'onoff', 'measure_battery', 'alarm_generic',
          'mower_status', 'measure_mow_progress', 'measure_mow_area', 'mow_blade_height',
          'measure_wifi_rssi', 'measure_ble_rssi', 'measure_gps_stars',
          'measure_mowing_speed', 'measure_elapsed_time', 'measure_left_time',
          'active_transport',
        ],
      };
    });
  }

  /**
   * Retrieve a valid session, refreshing or re-logging in if needed.
   * AuthError (bad/expired password) is translated to the localized message so
   * the user sees "invalid credentials" rather than a raw error, and knows to
   * use the device's Repair flow.
   */
  async getValidSession(): Promise<AuthSession> {
    const stored = this.homey.settings.get(SESSION_SETTINGS_KEY) as AuthSession | null;
    const creds = this.homey.settings.get(CREDENTIALS_SETTINGS_KEY) as StoredCredentials | null;
    if (!creds) throw new Error(this.homey.__('error.not_authenticated'));

    if (!stored) {
      const fresh = await MammotionAuth.login(creds.email, creds.password).catch((err) => {
        if (err instanceof AuthError) throw new Error(this.homey.__('error.invalid_credentials'));
        throw err;
      });
      await this.homey.settings.set(SESSION_SETTINGS_KEY, fresh);
      return fresh;
    }

    const refreshed = await MammotionAuth.ensureValidSession(stored, creds.email, creds.password).catch((err) => {
      if (err instanceof AuthError) throw new Error(this.homey.__('error.invalid_credentials'));
      throw err;
    });
    if (refreshed !== stored) await this.homey.settings.set(SESSION_SETTINGS_KEY, refreshed);
    return refreshed;
  }
}
