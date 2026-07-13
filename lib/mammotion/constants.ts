'use strict';

import { HOMEY_ENV } from '../util/homeyEnv.js';

/** OAuth2 client credentials for the Mammotion API — supplied via env.json (see
 *  lib/util/homeyEnv.ts), never committed to the repo. Populate a local, git-ignored
 *  env.json for development; CI writes it from repository secrets before publishing
 *  (see .github/workflows). */
export const OAUTH_APP_KEY: string = HOMEY_ENV.MAMMOTION_OAUTH_APP_KEY;
export const OAUTH_APP_SECRET: string = HOMEY_ENV.MAMMOTION_OAUTH_APP_SECRET;
export const TOKEN_ENDPOINT = '/oauth2/token';

/** Base URLs. */
export const MAMMOTION_DOMAIN = 'https://id.mammotion.com';
export const MAMMOTION_API_DOMAIN = 'https://domestic.mammotion.com';
export const APP_VERSION = '2.3.8.19';

/** BLE discovery constants. */
export const BLE_SERVICE_UUID = '0000ffff-0000-1000-8000-00805f9b34fb';
export const BLE_LOCAL_NAME_PREFIXES = ['Luba-', 'Yuka-'];

/** MQTT keepalive and reconnect tuning. */
export const MQTT_RECONNECT_PERIOD_MS = 5_000;
export const MQTT_CONNECT_TIMEOUT_MS = 15_000;

/** Device type codes returned by the API (field deviceType). */
export const DEVICE_TYPE_NAMES: Record<number, string> = {
  0: 'RTK',
  1: 'Luba 1',
  2: 'Luba 2',
  3: 'Yuka',
  4: 'Yuka Mini',
  5: 'Yuka Mini 2',
  6: 'Luba VP',
  7: 'Luba MN',
  8: 'Yuka VP',
  9: 'Spino',
  11: 'Luba LD',
  16: 'Yuka ML',
  17: 'Luba MD',
  18: 'Luba LA',
  23: 'Luba MB',
};

/** sys_status values that indicate a mowing job is still active (working, returning to
 *  dock as the final step, paused mid-job, or paused-while-charging-mid-job) — verified
 *  against pymammotion's own `MOWING_ACTIVE_MODES` in device_constant.py. Used to derive
 *  the `onoff` capability: previously onoff was only true for MODE_WORKING/MANUAL_MOWING,
 *  so a transient/unmapped work-mode value passed through briefly during a normal
 *  mowing→returning→charging sequence flipped onoff off and back on within seconds — a
 *  real user reported 20-30 spurious "turned off" Homey notifications overnight from
 *  exactly this (2026-07-05). */
export const MOWING_ACTIVE_WORK_MODES: readonly number[] = [13, 14, 19, 39];

/** Work mode codes from the mower telemetry. */
export const WORK_MODE: Record<number, string> = {
  0: 'not_active',
  1: 'online',
  2: 'offline',
  8: 'disabled',
  10: 'initializing',
  11: 'ready',
  12: 'unconnected',
  13: 'mowing',
  14: 'returning',
  15: 'charging',
  16: 'updating',
  17: 'locked',
  19: 'paused',
  20: 'manual_mowing',
  22: 'update_success',
  23: 'ota_fail',
  31: 'job_draw',
  32: 'obstacle_draw',
  34: 'channel_draw',
  35: 'eraser_draw',
  36: 'edit_boundary',
  37: 'location_error',
  38: 'boundary_jump',
  39: 'charging_pause',
};

/**
 * Product keys for the original Luba 1 (DeviceType.LUBA, value 1) — the only mower
 * classification below the "Luba 2 or higher" threshold that determines whether NAV
 * commands route to DEV_NAVIGATION vs DEV_MAINCTL. Verified against pymammotion's
 * device_type.py (LubaProductKey list) and cross-checked with DNAngelX/ioBroker.mammotion's
 * independently-generated product-keys.ts. Any OTHER recognized product key (Luba 2/VA/VP/
 * MN/LD/MD/LA/MB, Yuka family, CM900, …) is "Luba 2 or higher" and should use DEV_NAVIGATION.
 */
export const LEGACY_LUBA1_PRODUCT_KEYS: readonly string[] = [
  'a1UBFdq6nNz', 'a1x0zHD3Xop', 'a1pvCnb3PPu', 'a1kweSOPylG', 'a1JFpmAV5Ur',
  'a1BmXWlsdbA', 'a1jOhAYOIG8', 'a1K4Ki2L5rK', 'a1ae1QnXZGf', 'a1nf9kRBWoH', 'a1ZU6bdGjaM',
];

/** Product keys that are RTK base stations or pool robots — never paired through this
 *  mower driver, but excluded explicitly in case a productKey is ever seen unexpectedly. */
export const NON_MOWER_PRODUCT_KEYS: readonly string[] = [
  'a1qXkZ5P39W', 'a1Nc68bGZzX', 'a1wIIUUdAMX', 'a1mGLcddn4u', // RTK
  'a1NfZqdSREf', 'a1ZuQVL7UiN', // RTK NB
];
