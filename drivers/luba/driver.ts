
import Homey from 'homey';
import { MammotionAuth } from '../../lib/mammotion/auth/MammotionAuth.js';
import type { AuthSession, DeviceContext, MammotionDevice, DeviceRecord } from '../../lib/mammotion/auth/types.js';
import { DEVICE_TYPE_NAMES } from '../../lib/mammotion/constants.js';
import { AuthError } from '../../lib/mammotion/errors.js';
import { probeLegacyAliyunDevices, type AliyunLegacyCredentials } from '../../lib/mammotion/aliyun/AliyunLegacyProbe.js';
import type { AliyunAccountDevice } from '../../lib/mammotion/aliyun/types.js';
import { AliyunMqttTransport } from '../../lib/mammotion/aliyun/AliyunMqttTransport.js';
import { checkAliyunConnectivity } from '../../lib/mammotion/aliyun/connectivityCheck.js';
import { ALIYUN_DOMAIN } from '../../lib/mammotion/aliyun/constants.js';
import { AliyunCredentialsManager } from '../../lib/mammotion/aliyun/AliyunCredentialsManager.js';

const SESSION_SETTINGS_KEY = 'mammotion_session';
const CREDENTIALS_SETTINGS_KEY = 'mammotion_credentials';
const ALIYUN_CREDENTIALS_SETTINGS_KEY = 'mammotion_aliyun_credentials';

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
  private offlineTrigger!: Homey.FlowCardTriggerDevice;
  private onlineTrigger!: Homey.FlowCardTriggerDevice;

  // ─── Legacy Aliyun IoT support ────────────────────────────────────────────
  // ONE shared connection/credential set per account, not per device — see
  // docs/ALIYUN_MQTT_TRANSPORT_PLAN.md §1/§3. Every 'aliyun_legacy'-flagged LubaDevice
  // registers itself here rather than owning a private transport instance.
  private aliyunTransport: AliyunMqttTransport | null = null;
  private aliyunCredentialsManager!: AliyunCredentialsManager;

  /** Registers all Flow trigger/condition/action cards for this driver. */
  async onInit(): Promise<void> {
    this.log('LubaDriver initialized');
    this.registerFlowCards();
    this.aliyunCredentialsManager = new AliyunCredentialsManager({
      load: () => this.homey.settings.get(ALIYUN_CREDENTIALS_SETTINGS_KEY) ?? null,
      save: (credentials) => this.homey.settings.set(ALIYUN_CREDENTIALS_SETTINGS_KEY, credentials),
      log: (msg) => this.log(`[Aliyun credentials] ${msg}`),
      logError: (msg) => this.error(`[Aliyun credentials] ${msg}`),
    });
  }

  /** Tears down the shared Aliyun legacy transport, if one was ever created. */
  async onUninit(): Promise<void> {
    this.aliyunTransport?.disconnect();
  }

  /** Wires up every Flow card's run listener to the corresponding device method. */
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

    this.offlineTrigger = this.homey.flow.getDeviceTriggerCard('mower_offline');
    this.offlineTrigger.registerRunListener(() => true);

    this.onlineTrigger = this.homey.flow.getDeviceTriggerCard('mower_online');
    this.onlineTrigger.registerRunListener(() => true);

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

    this.homey.flow.getActionCard('set_blade_speed')
      .registerRunListener(async (args: { device: Homey.Device; speed: 'economic' | 'standard' | 'performance' }) => {
        await (args.device as any).actionSetBladeSpeed(args.speed);
      });

    this.homey.flow.getActionCard('set_rain_protection')
      .registerRunListener(async (args: { device: Homey.Device; enabled: string }) => {
        await (args.device as any).actionSetRainProtection(args.enabled === 'true');
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

  /** Called by LubaDevice when it transitions from available to unavailable (mower
   *  confirmed offline — either the mower reported it via the cloud, or the transport
   *  itself dropped). Fired at most once per transition, not on every retry. */
  triggerMowerOffline(device: Homey.Device): void {
    this.offlineTrigger.trigger(device, {}, {}).catch(this.error.bind(this));
  }

  /** Called by LubaDevice when it transitions from unavailable back to available. */
  triggerMowerOnline(device: Homey.Device): void {
    this.onlineTrigger.trigger(device, {}, {}).catch(this.error.bind(this));
  }

  // ─── Legacy Aliyun IoT support ────────────────────────────────────────────

  /** Public accessor for LubaDevice's Aliyun command-sending path (sendAliyunCloudCommand)
   *  and requestSync's poll loop. Delegates all caching/expiry/circuit-breaker logic to
   *  AliyunCredentialsManager (see that module for why this exists). */
  async getAliyunCredentials(): Promise<AliyunLegacyCredentials> {
    const session = await this.getValidSession();
    return this.aliyunCredentialsManager.ensure(session);
  }

  /** Seeds the credential cache from a probe result the caller already has (e.g. pairing's
   *  list_devices, which runs the full handshake anyway) — avoids an unnecessary second
   *  handshake the moment the first newly-paired legacy device initializes. */
  private cacheAliyunCredentials(credentials: AliyunLegacyCredentials): void {
    this.aliyunCredentialsManager.seed(credentials);
  }

  /** Drops the cached Aliyun credentials so the next call re-runs the handshake — call this
   *  after a command/connection fails with an auth-expiry code (460/29003, see
   *  AliyunCommandError) before retrying, rather than retrying with the same stale token. */
  invalidateAliyunCredentials(): void {
    this.aliyunCredentialsManager.invalidate();
  }

  /** Registers a legacy-bound device onto the shared AliyunMqttTransport, creating and
   *  connecting it on first use. Safe to call for multiple devices — they share one
   *  connection (see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md's "one connection per account"
   *  correction, not one per device). */
  async registerAliyunDevice(
    iotId: string,
    onMessage: (decoded: Record<string, unknown>) => void,
    onStatus: (online: boolean) => void,
  ): Promise<void> {
    const credentials = await this.getAliyunCredentials();
    if (!this.aliyunTransport) {
      this.aliyunTransport = new AliyunMqttTransport({
        config: credentials,
        log: (msg) => this.log(`[Aliyun] ${msg}`),
        logError: (msg) => this.error(`[Aliyun] ${msg}`),
      });
    }
    this.aliyunTransport.registerDevice(iotId, onMessage, onStatus);
    if (!this.aliyunTransport.isConnected) this.aliyunTransport.connect();
  }

  /** Removes a device from the shared transport's routing table on cleanup/deletion — does
   *  not tear down the connection itself, since other legacy devices may still be registered. */
  unregisterAliyunDevice(iotId: string): void {
    this.aliyunTransport?.unregisterDevice(iotId);
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
      // Mirrors pymammotion's login_and_initiate_cloud: the mobile app's "Accept" UI is
      // supposed to finalize a device-share invitation server-side, but a headless login
      // has no equivalent step. Confirming any still-pending shares here closes that gap —
      // this is the fix for the recurring "no devices found" pairing bug (see memory).
      const shareResult = await MammotionAuth.acceptPendingShares(session).catch((err) => {
        this.error('acceptPendingShares failed:', err);
        return { found: 0, accepted: 0 };
      });
      // found=0 on an account with mowers confirmed visible in the mobile app points at
      // the legacy Aliyun IoT sharing system this app doesn't implement, not this endpoint.
      this.log(`list_devices: share invitations found=${shareResult.found} accepted=${shareResult.accepted}`);

      // The records endpoint is authoritative (it includes shared-not-owned mowers) —
      // if it fails, surface the error to the user rather than showing an empty list.
      // The owned-devices endpoint only backfills identifiers, so its failure is tolerable.
      const [devices, recordsResult] = await Promise.all([
        MammotionAuth.fetchDevices(session).catch((err) => {
          this.error('fetchDevices failed:', err);
          return [];
        }),
        MammotionAuth.fetchDeviceRecords(session).catch((err) => {
          this.error('fetchDeviceRecords failed:', err);
          throw new Error(`${this.homey.__('error.no_devices_found')} (${err instanceof Error ? err.message : String(err)})`);
        }),
      ]);
      const records = recordsResult.records;
      // total/msg let a submitted diagnostic report tell "API genuinely has 0 devices for
      // this account" (total=0) apart from "API knows about devices but withheld them"
      // (total>0, records=0) — see the recurring shared-account pairing bug in memory.
      this.log(`list_devices: owned=${devices.length} records=${records.length} total=${recordsResult.total} msg=${JSON.stringify(recordsResult.msg)}`,
        JSON.stringify({
          owned: devices.map(d => ({ iotId: d.iotId, deviceName: d.deviceName })),
          records: records.map(r => ({ iotId: r.iotId, deviceName: r.deviceName, productKey: r.productKey })),
        }));
      const list = this.buildDeviceList(devices, records);

      // Raw TLS reachability check against the legacy handshake's fixed entry point, run
      // alongside (not blocking) the real probe below — isolates "can we even reach Aliyun's
      // servers from this network" from "did the 6-step handshake itself fail", after a real
      // diagnostic report showed the same account/handshake failing consistently from one
      // Homey hub's network while working fine from another. See connectivityCheck.ts.
      checkAliyunConnectivity(ALIYUN_DOMAIN)
        .then((result) => this.log(`list_devices: Aliyun connectivity check (${ALIYUN_DOMAIN}) — ${result}`))
        .catch((err) => this.error('Aliyun connectivity check threw unexpectedly:', err));

      // Always probe the legacy Aliyun IoT Link Platform too, even when the normal path
      // already found devices — an account can have SOME mowers on each system at once
      // (e.g. one owned mower via the normal API, plus a mower shared to this account only
      // through the legacy system). Previously this only ran when `list` was empty, which
      // silently hid legacy-only devices whenever the account had at least one normal
      // device — the actual root cause of a real user's shared mower never appearing in
      // the pairing list (confirmed via scripts/test-accounts.ts against a real account:
      // records=1 normal device + bound=1 legacy device, only the former was ever shown).
      // This is read-only: it never blocks pairing on its own failure and never modifies
      // any account state. See [[architecture-decisions]] #14b.
      //
      // One retry: this handshake reaches Aliyun's Chinese cloud endpoints directly from
      // the Homey hub's own network, and a real diagnostic report showed a transient
      // ETIMEDOUT/ENETUNREACH against that endpoint from an otherwise-working account/
      // network (the same handshake had succeeded repeatedly minutes earlier). Pairing is
      // a one-shot UX moment, so it's worth riding out exactly this kind of blip rather
      // than silently dropping legacy-only devices for the rest of the session.
      let legacyResult = await probeLegacyAliyunDevices(session).catch((err) => {
        this.error('probeLegacyAliyunDevices failed (attempt 1):', err);
        return null;
      });
      if (!legacyResult) {
        legacyResult = await probeLegacyAliyunDevices(session).catch((err) => {
          this.error('probeLegacyAliyunDevices failed (attempt 2):', err);
          return null;
        });
      }
      if (legacyResult) {
        this.log(`list_devices: legacy Aliyun probe — bound=${legacyResult.boundDevices.length} shareNotifications=${legacyResult.shareNotifications}`,
          JSON.stringify(legacyResult.boundDevices.map(d => ({ iotId: d.iotId, deviceName: d.deviceName, productKey: d.productKey, owned: d.owned }))));
        if (legacyResult.regionFallback) {
          // The dynamic region lookup was unreachable and we fell back to the static
          // country→region table — mapped:false means countryCode had NO table entry at all
          // and a default was guessed. This app ships in every country its 13 locales cover,
          // not just the ones currently in ALIYUN_REGION_MAPPINGS, so an unmapped code here
          // is a concrete signal for which region to add next (see regionMappings.ts).
          const { countryCode, region, mapped } = legacyResult.regionFallback;
          this.log(`list_devices: region lookup fell back to static table — countryCode=${countryCode} region=${region} mapped=${mapped}`);
        }
      }
      if (legacyResult && legacyResult.boundDevices.length > 0) {
        // Real, listable devices via the legacy system — pair them for real now that
        // read+write support exists (docs/ALIYUN_MQTT_TRANSPORT_PLAN.md). Cache the
        // credentials this same probe call already fetched so the driver doesn't need to
        // re-run the handshake the moment the first legacy device initializes.
        if (legacyResult.credentials) this.cacheAliyunCredentials(legacyResult.credentials);
        // De-dupe by iotId in case a device is somehow visible on both systems — the
        // normal-path entry wins since it has richer/more current metadata.
        const seenIotIds = new Set(list.map((d) => d.data.id));
        const legacyList = this
          .buildLegacyDeviceList(legacyResult.boundDevices)
          .filter((d) => !seenIotIds.has(d.data.id));
        const merged = [...list, ...legacyList];
        // Confirms the merged list actually reaches the return statement (and is well-formed)
        // before handing it to Homey's pairing UI — closes the observability gap between "we
        // found bound devices" and "the wizard actually showed them" for the next diagnostic
        // report, since nothing downstream of this point is currently logged.
        this.log(`list_devices: returning ${merged.length} device(s) to pairing UI (${list.length} normal + ${legacyList.length} legacy)`,
          JSON.stringify(merged.map((d) => ({ name: d.name, id: d.data.id }))));
        return merged;
      }
      if (list.length > 0) return list;
      if (legacyResult && legacyResult.shareNotifications > 0) {
        // Evidence of legacy sharing activity but nothing actually bound/listable yet —
        // still an informative message rather than the generic one.
        throw new Error(this.homey.__('error.legacy_devices_found'));
      }

      // Zero devices on both systems usually means the sharing invitation hasn't been
      // accepted yet (or hasn't propagated) — tell the user what to check instead of
      // showing Homey's generic "no new devices found".
      throw new Error(this.homey.__('error.no_devices_found'));
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
    await MammotionAuth.acceptPendingShares(session).catch((err) => {
      this.error('acceptPendingShares failed:', err);
    });
    const [devices, recordsResult] = await Promise.all([
      MammotionAuth.fetchDevices(session),
      MammotionAuth.fetchDeviceRecords(session),
    ]);
    return this.buildDeviceList(devices, recordsResult.records);
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
        store: { context: { ...context, transportKind: 'mammotion' } },
        capabilities: LubaDriver.PAIRING_CAPABILITIES,
      };
    });
  }

  /**
   * Builds the paired-device list for mowers only visible through the legacy Aliyun IoT
   * Link Platform system (docs/ALIYUN_LEGACY_PLAN.md) — same capability set as
   * buildDeviceList's normal path, since legacy devices expose the identical Homey
   * capability surface; only the transport underneath differs (see
   * docs/ALIYUN_MQTT_TRANSPORT_PLAN.md §1's same-driver decision).
   */
  private buildLegacyDeviceList(boundDevices: AliyunAccountDevice[]): PairedDeviceResult[] {
    return boundDevices.map((device): PairedDeviceResult => {
      const context: DeviceContext = {
        iotId: device.iotId,
        deviceId: device.iotId,
        deviceName: device.deviceName,
        productKey: device.productKey,
        recordDeviceName: device.deviceName,
        status: null,
        deviceType: null,
        transportKind: 'aliyun_legacy',
      };
      return {
        name: device.nickName || context.deviceName || context.iotId,
        data: { id: context.iotId },
        store: { context },
        capabilities: LubaDriver.PAIRING_CAPABILITIES,
      };
    });
  }

  /** Capabilities assigned to every newly paired device, regardless of transport kind — Homey
   *  uses THIS pairing-time list (not driver.compose.json's manifest) to set up a new
   *  device's capabilities, so anything missing here is silently absent until repair.
   *  Keep in sync with driver.compose.json's top-level "capabilities" array by hand. */
  private static readonly PAIRING_CAPABILITIES: string[] = [
    'onoff', 'measure_battery', 'alarm_generic',
    'mower_status', 'measure_mow_progress', 'measure_mow_area', 'mow_blade_height',
    'measure_wifi_rssi', 'measure_ble_rssi', 'measure_gps_stars',
    'measure_mowing_speed', 'measure_elapsed_time', 'measure_left_time',
    'active_transport', 'mow_cutter_mode', 'mow_headlamp', 'mow_side_led',
    'mow_pos_level', 'mow_rain_protection', 'measure_battery_cycles', 'measure_blade_used_time',
    'mow_send_to_dock',
  ];

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

  /** Drops the cached session so the next getValidSession() call performs a full fresh
   *  login instead of trusting the stored session's client-side expiresAt clock — that
   *  clock can say "still valid" for several more minutes while the server has already
   *  invalidated the token (API responds with its own `code: 401`), which otherwise left
   *  devices retrying with the same broken token in an escalating reconnect loop for
   *  several minutes straight (see a real diagnostic report). Call this when a cloud API
   *  call fails with an explicit 401 despite ensureValidSession() considering it current. */
  invalidateSession(): void {
    this.homey.settings.unset(SESSION_SETTINGS_KEY);
  }
}
