'use strict';

/**
 * TypeScript port of pymammotion's `device_type.py` (mikey0000/PyMammotion,
 * pymammotion/utility/device_type.py, verified against source 2026-07-03) — the DeviceType
 * enum, its name-prefix/product-key resolution (value_of_str), and the specific predicates
 * this app's per-model capability gating needs (docs/CAPABILITY_DIFFERENTIATION_PLAN.md).
 *
 * Ported faithfully in full (every device type and the exact rule-chain order), even though
 * this app currently only pairs Luba-family devices — value_of_str's priority order only
 * resolves correctly if every rule ahead of the ones we care about is present, and Yuka/Spino/
 * RTK support is on the roadmap. Cross-checked product-key lists against
 * DNAngelX/ioBroker.mammotion's independently-generated table, matching the standard this repo
 * already applies to LEGACY_LUBA1_PRODUCT_KEYS in constants.ts.
 *
 * Deliberately separate from LubaCommands.ts's isLubaProDevice()/LEGACY_LUBA1_PRODUCT_KEYS —
 * that logic is already tested and shipping for NAV command routing; this module is additive,
 * used only for capability-set gating, not a replacement.
 */

export enum DeviceType {
  UNKNOWN = -1,
  RTK = 0,
  LUBA = 1,
  LUBA_2 = 2,
  LUBA_YUKA = 3,
  YUKA_MINI = 4,
  YUKA_MINI2 = 5,
  LUBA_VP = 6,
  LUBA_MN = 7,
  YUKA_VP = 8,
  SPINO = 9,
  RTK3A1 = 10,
  LUBA_LD = 11,
  RTK3A0 = 12,
  RTK3A2 = 13,
  YUKA_MINIV = 14,
  LUBA_VA = 15,
  YUKA_ML = 16,
  LUBA_MD = 17,
  LUBA_LA = 18,
  SWIMMINGPOOL_S1 = 19,
  SWIMMINGPOOL_E1 = 20,
  YUKA_MN100 = 21,
  RTKNB = 22,
  LUBA_MB = 23,
  CM900 = 24,
  YUKA_MN101 = 25,
  SWIMMINGPOOL_SP = 26,
  SD_PX = 27,
  LUBA_HM = 28,
  LUBA_ME = 29,
}

/** Device-name prefix per type, used by resolveDeviceType. */
const NAME_PREFIX: Record<DeviceType, string> = {
  [DeviceType.UNKNOWN]: 'UNKNOWN',
  [DeviceType.RTK]: 'RTK',
  [DeviceType.LUBA]: 'Luba',
  [DeviceType.LUBA_2]: 'Luba-VS',
  [DeviceType.LUBA_YUKA]: 'Yuka-',
  [DeviceType.YUKA_MINI]: 'Yuka-MN',
  [DeviceType.YUKA_MINI2]: 'Yuka-YM',
  [DeviceType.LUBA_VP]: 'Luba-VP',
  [DeviceType.LUBA_MN]: 'Luba-MN',
  [DeviceType.YUKA_VP]: 'Yuka-VP',
  [DeviceType.SPINO]: 'Spino',
  [DeviceType.RTK3A1]: 'RBSA1',
  [DeviceType.LUBA_LD]: 'Luba-LD',
  [DeviceType.RTK3A0]: 'RBSA0',
  [DeviceType.RTK3A2]: 'RBSA2',
  [DeviceType.YUKA_MINIV]: 'Yuka-MV',
  [DeviceType.LUBA_VA]: 'Luba-VA',
  [DeviceType.YUKA_ML]: 'Yuka-ML',
  [DeviceType.LUBA_MD]: 'Luba-MD',
  [DeviceType.LUBA_LA]: 'Luba-LA',
  [DeviceType.SWIMMINGPOOL_S1]: 'Spino-S1',
  [DeviceType.SWIMMINGPOOL_E1]: 'Spino-E1',
  [DeviceType.YUKA_MN100]: 'Ezy-VT',
  [DeviceType.RTKNB]: 'NB',
  [DeviceType.LUBA_MB]: 'Luba-MB',
  [DeviceType.CM900]: 'Kumar-MK',
  [DeviceType.YUKA_MN101]: 'Ezy-LD',
  [DeviceType.SWIMMINGPOOL_SP]: 'Spino-SP',
  [DeviceType.SD_PX]: 'SDPX',
  [DeviceType.LUBA_HM]: 'Luba-HM',
  [DeviceType.LUBA_ME]: 'Luba-ME',
};

/** Human-readable model string per type — diagnostic/logging use only. */
export const MODEL_STRING: Record<DeviceType, string> = {
  [DeviceType.UNKNOWN]: 'Unknown',
  [DeviceType.RTK]: 'RTK',
  [DeviceType.LUBA]: 'Luba 1',
  [DeviceType.LUBA_2]: 'Luba 2',
  [DeviceType.LUBA_YUKA]: 'Yuka',
  [DeviceType.YUKA_MINI]: 'Yuka Mini',
  [DeviceType.YUKA_MINI2]: 'Yuka Mini 2',
  [DeviceType.LUBA_VP]: 'Luba VP',
  [DeviceType.LUBA_MN]: 'HM430',
  [DeviceType.YUKA_VP]: 'MN241',
  [DeviceType.SPINO]: 'Spino',
  [DeviceType.RTK3A1]: 'RBS03A1',
  [DeviceType.LUBA_LD]: 'HM431',
  [DeviceType.RTK3A0]: 'RBS03A0',
  [DeviceType.RTK3A2]: 'RBS03A2',
  [DeviceType.YUKA_MINIV]: 'MN231',
  [DeviceType.LUBA_VA]: 'HM442',
  [DeviceType.YUKA_ML]: 'MN232',
  [DeviceType.LUBA_MD]: 'HM433',
  [DeviceType.LUBA_LA]: 'HM432',
  [DeviceType.SWIMMINGPOOL_S1]: 'Spino-S1',
  [DeviceType.SWIMMINGPOOL_E1]: 'Spino-E1',
  [DeviceType.YUKA_MN100]: 'MN100',
  [DeviceType.RTKNB]: 'NB',
  [DeviceType.LUBA_MB]: 'HM434',
  [DeviceType.CM900]: 'KM01',
  [DeviceType.YUKA_MN101]: 'MN101',
  [DeviceType.SWIMMINGPOOL_SP]: 'Spino-SP',
  [DeviceType.SD_PX]: 'SDPX',
  [DeviceType.LUBA_HM]: 'HM610',
  [DeviceType.LUBA_ME]: 'HM620',
};

const LUBA_PRODUCT_KEYS: readonly string[] = [
  'a1UBFdq6nNz', 'a1x0zHD3Xop', 'a1pvCnb3PPu', 'a1kweSOPylG', 'a1JFpmAV5Ur',
  'a1BmXWlsdbA', 'a1jOhAYOIG8', 'a1K4Ki2L5rK', 'a1ae1QnXZGf', 'a1nf9kRBWoH', 'a1ZU6bdGjaM',
];
const LUBA_V_PRODUCT_KEYS: readonly string[] = ['a1iMygIwxFC', 'a1LLmy1zc0j']; // LUBA_2
const LUBA_ME_PRODUCT_KEYS: readonly string[] = ['HK8snDC8Kxh'];
const RTK_PRODUCT_KEYS: readonly string[] = ['a1qXkZ5P39W', 'a1Nc68bGZzX', 'a1wIIUUdAMX', 'a1mGLcddn4u'];

/** Ordered (device type, device-name slice length, optional product-key predicate) rules for
 *  resolveDeviceType — reproduces pymammotion's `_VALUE_OF_STR_RULES` if-chain exactly. Order
 *  is significant: specific "Luba-XX"/"Yuka-XX" prefixes are checked before the generic
 *  "Luba" fallback, and the product-key checks fire at the same positions they did upstream. */
const VALUE_OF_STR_RULES: ReadonlyArray<readonly [DeviceType, number, ((productKey: string) => boolean) | null]> = [
  [DeviceType.RTK, 3, (pk) => !!pk && RTK_PRODUCT_KEYS.includes(pk)],
  [DeviceType.LUBA_2, 7, (pk) => !!pk && LUBA_V_PRODUCT_KEYS.includes(pk)],
  [DeviceType.LUBA_LD, 7, null],
  [DeviceType.LUBA_VP, 7, null],
  [DeviceType.LUBA_MN, 7, null],
  [DeviceType.YUKA_VP, 7, null],
  [DeviceType.YUKA_MINI, 7, null],
  [DeviceType.YUKA_MINI2, 7, null],
  [DeviceType.RTK3A1, 7, null],
  [DeviceType.RTK3A0, 7, null],
  [DeviceType.RTK3A2, 7, null],
  [DeviceType.YUKA_MINIV, 7, null],
  [DeviceType.LUBA_VA, 7, null],
  [DeviceType.YUKA_ML, 7, null],
  [DeviceType.LUBA_MD, 7, null],
  [DeviceType.LUBA_LA, 7, null],
  [DeviceType.LUBA_YUKA, 7, null],
  [DeviceType.SWIMMINGPOOL_S1, 8, null],
  [DeviceType.SWIMMINGPOOL_E1, 8, null],
  [DeviceType.SWIMMINGPOOL_SP, 8, null],
  [DeviceType.SPINO, 7, null],
  [DeviceType.YUKA_MN100, 7, null],
  [DeviceType.YUKA_MN101, 7, null],
  [DeviceType.RTKNB, 7, null],
  [DeviceType.LUBA_MB, 7, null],
  [DeviceType.CM900, 7, null],
  [DeviceType.SD_PX, 7, null],
  [DeviceType.LUBA_HM, 7, null],
  [DeviceType.LUBA_ME, 7, (pk) => !!pk && LUBA_ME_PRODUCT_KEYS.includes(pk)],
  [DeviceType.LUBA, 7, (pk) => !!pk && LUBA_PRODUCT_KEYS.includes(pk)],
];

/** Resolves a device's DeviceType from its device name and/or product key — mirrors
 *  pymammotion's `DeviceType.value_of_str`. Either input alone can resolve it; both are
 *  already available on DeviceContext at pairing time, no extra API call needed. */
export function resolveDeviceType(deviceName: string, productKey = ''): DeviceType {
  if (!deviceName && !productKey) return DeviceType.UNKNOWN;
  for (const [deviceType, nameSlice, productKeyMatch] of VALUE_OF_STR_RULES) {
    const slice = deviceName.slice(0, nameSlice);
    if (slice.includes(NAME_PREFIX[deviceType]) || (productKeyMatch !== null && productKeyMatch(productKey))) {
      return deviceType;
    }
  }
  return DeviceType.UNKNOWN;
}

/** True for the "mini/X-series" models — mirrors `DeviceType.is_mini_or_x_series()`. Gates
 *  upstream's manual/night-auto lighting-*mode* UI (HA's `night_light`/`manual_light`
 *  entities, `SocMul.set_lamp`), not headlamp hardware presence — see hasHeadlamp() for that
 *  (docs/CAPABILITY_DIFFERENTIATION_PLAN.md, 2026-07-09 decision). Kept as a faithful port for
 *  a possible future split between "has a headlamp" and "has this extra manual/night mode UI". */
export function isMiniOrXSeries(deviceType: DeviceType): boolean {
  return [
    DeviceType.YUKA_MINI, DeviceType.YUKA_MINI2, DeviceType.YUKA_MINIV, DeviceType.YUKA_ML,
    DeviceType.YUKA_VP, DeviceType.LUBA_MN, DeviceType.LUBA_VP, DeviceType.LUBA_LD,
  ].includes(deviceType);
}

/** True for any Luba-family or Yuka-family mower — mirrors `DeviceType.is_luba_type() ||
 *  DeviceType.is_yu_ka_type()`. All of these have a front headlamp per vendor spec pages
 *  (docs/CAPABILITY_DIFFERENTIATION_PLAN.md, 2026-07-09 decision); RTK base stations,
 *  swimming-pool robots (Spino/SD_PX), and UNKNOWN do not. */
export function hasHeadlamp(deviceType: DeviceType): boolean {
  return [
    DeviceType.LUBA, DeviceType.LUBA_2, DeviceType.LUBA_VP, DeviceType.LUBA_MN,
    DeviceType.LUBA_LD, DeviceType.LUBA_VA, DeviceType.LUBA_HM, DeviceType.LUBA_ME,
    DeviceType.LUBA_MB, DeviceType.LUBA_LA, DeviceType.CM900,
    DeviceType.LUBA_YUKA, DeviceType.YUKA_MINI, DeviceType.YUKA_MINI2, DeviceType.YUKA_VP,
    DeviceType.YUKA_MINIV, DeviceType.YUKA_MN100, DeviceType.YUKA_MN101, DeviceType.YUKA_ML,
  ].includes(deviceType);
}

/** False for models with a removable/detachable battery pack that don't report a meaningful
 *  cycle count — mirrors `DeviceType.supports_battery_cycle_count()`. */
export function supportsBatteryCycleCount(deviceType: DeviceType): boolean {
  return ![
    DeviceType.YUKA_MINI, DeviceType.YUKA_ML, DeviceType.LUBA_MN, DeviceType.YUKA_MINIV,
    DeviceType.YUKA_MN100, DeviceType.YUKA_MN101, DeviceType.LUBA_LD, DeviceType.LUBA_LA,
    DeviceType.LUBA_MB,
  ].includes(deviceType);
}

/** Filters a driver's full/base capability list down to the ones a specific model actually
 *  has. The single source of truth for per-model capability gating
 *  (docs/CAPABILITY_DIFFERENTIATION_PLAN.md) — used both at pairing time (LubaDriver's
 *  buildDeviceList/buildLegacyDeviceList) and by device.ts's onInit() migration, so a model's
 *  capability set can never drift between a newly paired device and an already-paired one.
 *  Takes the base list as a parameter (rather than importing LubaDriver directly) to avoid a
 *  circular import between this module and driver.ts.
 *
 *  Gated so far (docs/CAPABILITY_DIFFERENTIATION_PLAN.md's verified findings):
 *  - mow_headlamp: any Luba-family or Yuka-family mower (not RTK base stations or
 *    swimming-pool robots) — see hasHeadlamp().
 *  - measure_battery_cycles: not on removable-battery-pack models.
 *  Every other capability in the base list is currently unconditional — no verified upstream
 *  evidence to gate mow_side_led or mow_rain_protection yet (see that doc's "Open questions"). */
export function capabilitiesForModel(baseCapabilities: readonly string[], deviceType: DeviceType): string[] {
  return baseCapabilities.filter((capability) => {
    if (capability === 'mow_headlamp') return hasHeadlamp(deviceType);
    if (capability === 'measure_battery_cycles') return supportsBatteryCycleCount(deviceType);
    return true;
  });
}
