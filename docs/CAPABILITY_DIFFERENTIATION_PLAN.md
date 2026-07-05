# Per-model capability differentiation — plan

## Why this exists

Every device paired through the `luba` driver gets the **same** fixed capability list
(`LubaDriver.PAIRING_CAPABILITIES` in `drivers/luba/driver.ts`, mirrored in
`drivers/luba/driver.compose.json`'s top-level `capabilities`), regardless of hardware. That
list includes model-specific controls — `mow_headlamp`, `mow_side_led`, `mow_rain_protection`,
`measure_battery_cycles` — that not every Mammotion model actually has.

Concrete report: a user's **Luba 2 Mini 1000** ("Shaun", nickname, `productKey=a1dCWYFLROK`,
legacy Aliyun transport) has **no headlamp**, yet Luba 3 does. We expose `mow_headlamp` on it
anyway. The capability is a dead toggle: it sends a command the hardware ignores and never
reflects real state.

This doc answers: how does the reference implementation decide capabilities per model, and how
should this Homey app do the same given Homey's fixed-at-pairing capability constraint.

## What was found (reference source, verified)

All findings below are read directly from `mikey0000/pymammotion` and `mikey0000/Mammotion-HA`
on GitHub, not inferred.

### Model detection: `DeviceType.value_of_str(device_name, product_key)`

`pymammotion/utility/device_type.py` is the single source of model identity. A `DeviceType`
enum carries `(numeric_id, name_prefix, model_string)` per model. `value_of_str()` resolves a
device to a `DeviceType` by, in a fixed priority order, either:

1. matching the leading N chars of `device_name` against a prefix (`"Luba-VS"` → LUBA_2,
   `"Luba-MN"` → LUBA_MN, `"Yuka-"` → LUBA_YUKA, etc. — most use `[:7]`, RTK uses `[:3]`,
   Spino uses `[:8]`), **or**
2. matching `product_key` against a per-model product-key list.

Both inputs are needed; either can resolve it. Crucially **both are available to us at pairing
time already** — `DeviceContext` carries `deviceName` and `productKey` (see
`buildLegacyDeviceList`/`buildDeviceList` in `driver.ts`). No extra API call is required.

For Shaun: `deviceName` `Luba-MNJR4AS3` (from `ALIYUN_MQTT_TRANSPORT_PLAN.md`, log evidence)
has prefix `Luba-MN` → **LUBA_MN** ("HM430", the Luba 2 Mini). `productKey=a1dCWYFLROK` is in
`Luba2MiniProductKey` → also resolves LUBA_MN. Consistent. So a Luba 2 Mini is *not* the same
`DeviceType` as a standard Luba 2 (`LUBA_2` / "Luba-VS"), even though the user calls both
"Luba 2".

### How capabilities are gated (HA `switch.py` / `sensor.py`, verified)

HA does **not** have a single feature table. It builds entities per platform and gates each
group with `DeviceType` predicates at setup time. Relevant to us:

- **Headlamp** = `manual_light` + `night_light` async switches. Gated to
  `DeviceType.is_mini_or_x_series(device_name)` — i.e. present on YUKA_MINI/MINI2/MINIV/ML,
  YUKA_VP, **LUBA_MN, LUBA_VP, LUBA_LD** (mini/pro/X-series). NOT present on a standard
  Luba 2, and NOT present on a full-size Luba 3-class device in that group either. (See
  `MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES` + the `is_mini_or_x_series` guard.)
- **`side_led`** switch is in the **base** `SWITCH_ENTITIES` — added to *every* mower
  unconditionally in HA. So side LED is not model-gated upstream.
- **`rain_detection`** is also in base `SWITCH_ENTITIES` (unconditional upstream). A separate
  `rain_tactics` config knob and `is_dump`/`is_edge`/`is_turn` live in
  `YUKA_CONFIG_SWITCH_ENTITIES`, gated to Yuka-non-mini only.
- **`measure_battery_cycles`**: `sensor.py` only adds the mini-excluded battery sensors when
  `device_type.supports_battery_cycle_count()` is True. That method returns **False** for
  YUKA_MINI, YUKA_ML, **LUBA_MN**, YUKA_MINIV, YUKA_MN100, YUKA_MN101, **LUBA_LD, LUBA_LA,
  LUBA_MB** — these use removable battery packs and report no cycle count. So Shaun (LUBA_MN)
  should also **not** have `measure_battery_cycles`.
- Other model gates seen in `sensor.py`: `LUBA_SENSOR_ONLY_TYPES` when `not is_yuka`;
  `LUBA_2_YUKA_*` sensor groups when `is_luba_pro` (= LUBA_2 or higher, non-RTK, non-pool);
  `LUBA_1_SIGNAL_TYPES` when `is_luba1`. This repo's `LEGACY_LUBA1_PRODUCT_KEYS` already
  encodes the Luba-1 split for command routing.

### Important nuance for our headlamp mapping

Our `mow_headlamp` and `mow_side_led` both call `actionSetHeadlamp(value, <index>)` (index 0 vs
1) — a single command with a lamp index, not HA's separate `manual_light`/`night_light`/
`side_led` entities. So our two toggles do not map 1:1 to HA's three. The safe reading for the
first case: **headlamp (index 0) belongs to the mini/X-series gate; side LED we currently have
no upstream evidence to remove.** See "Open questions" — do not assume side LED is absent on
Shaun without telemetry confirmation.

## The Homey constraint that shapes the design

In Homey SDK 3 a device's capability set is established from the pairing result's
`capabilities` array (`PairedDeviceResult.capabilities`), NOT from `driver.compose.json` at
runtime. Once paired, the set is fixed unless the app explicitly calls `addCapability` /
`removeCapability` on the device (typically in `onInit`, a "capability migration"), or the user
runs a repair. So there are two levers:

1. **Pairing-time**: choose the capability list per detected model when building
   `PairedDeviceResult`. Clean for *new* pairings, does nothing for the ~existing installed
   base (already-paired devices keep their old set).
2. **Runtime migration**: in `device.ts onInit`, reconcile actual capabilities against the
   model's expected set via `addCapability`/`removeCapability`. This is what fixes Shaun and
   every other already-paired device without forcing a re-pair.

Both are needed. Pairing-time alone leaves existing users broken; migration alone works but
new pairings would still momentarily create the wrong set. Do both, driven by one shared
source of truth.

## Recommended mechanism

**Deterministic, product-key/name-driven capability table — chosen at pairing time AND
reconciled on every `onInit`.** Do NOT infer capabilities lazily from observed telemetry (see
Options rejected).

### Pieces to build

1. **Port the minimum of `device_type.py` to TS** — `lib/mammotion/deviceType.ts`:
   - a `DeviceType` enum (or const union) with the id/prefix/model,
   - the product-key lists we care about (at minimum `Luba2MiniProductKey`, `LubaVProductKey`,
     `LubaVProProductKey`, `LubaLDProductKey`, plus the Yuka lists if we ever expand),
   - `resolveDeviceType(deviceName, productKey)` mirroring `value_of_str` priority order,
   - predicate helpers actually used: `isMiniOrXSeries()`, `supportsBatteryCycleCount()`,
     `isLuba1()` (can supersede the ad-hoc `LEGACY_LUBA1_PRODUCT_KEYS` list in
     `constants.ts` — consolidate, don't duplicate).
   - Keep it a faithful port; cross-check the product-key lists against
     `DNAngelX/ioBroker.mammotion`'s independently-generated key table as we did for the
     Luba-1 routing bug.

2. **A single capability-set function** — `capabilitiesForModel(deviceType): string[]`. Starts
   from a base set (everything model-agnostic) and adds/removes the gated ones:
   - remove `mow_headlamp` unless `isMiniOrXSeries()`,
   - remove `measure_battery_cycles` unless `supportsBatteryCycleCount()`,
   - `mow_side_led`, `mow_rain_protection`: keep for now (no upstream removal evidence) —
     table makes it trivial to gate later once confirmed.
   This function is the ONE source of truth. `PAIRING_CAPABILITIES` becomes the base input to
   it; `driver.compose.json`'s manifest stays the superset (Homey requires every capability a
   device might ever have to be declared in the manifest — keep it complete).

3. **Pairing-time**: `buildDeviceList` / `buildLegacyDeviceList` call
   `capabilitiesForModel(resolveDeviceType(deviceName, productKey))` instead of the flat
   `PAIRING_CAPABILITIES`.

4. **Runtime migration in `device.ts onInit`** (before registering capability listeners):
   compute the expected set from the stored `context.deviceName`/`context.productKey`, diff
   against `this.getCapabilities()`, and `addCapability`/`removeCapability` to reconcile. Guard
   each call (they throw if the capability is missing from the manifest / already present) and
   log the migration once. Only register a capability listener for a capability the device
   actually has. This is the step that fixes Shaun in place.

### Why deterministic, not telemetry-inferred

- Homey wants the capability set fixed/known, ideally before first telemetry. Lazy inference
  means the tile changes shape minutes/hours after pairing — poor UX and racy.
- "Never populated" is not reliably "not supported": a healthy device that simply hasn't lit
  its headlamp reports the same absence as one with no headlamp. Telemetry can't distinguish
  them; the product-key/name table can, and it's exactly what the vendor app uses.
- We already have `deviceName` + `productKey` for free at pairing. No extra API surface, no new
  transport risk.

## What is explicitly NOT being built

- **No new light entities / no splitting `mow_headlamp` into manual+night light.** We keep our
  existing single-index lamp command shape. This plan only decides *whether* the toggle exists.
- **No per-model blade-height / speed / path-spacing limits** (the `device_config.py` /
  `DeviceLimits` data). Real and useful eventually, but out of scope here — this is
  capability *presence*, not capability *range*. Note it as a follow-up.
- **No Yuka/Spino/RTK support.** The table should be *structured* to accept them, but we only
  populate/verify the Luba family we ship (roadmap defers Yuka/Spino).
- **No repair-flow requirement.** Runtime migration avoids forcing existing users to re-pair.

## Verification — what can and cannot be checked before shipping

- **Verifiable now:** `resolveDeviceType` unit tests against known (name, productKey) pairs,
  including Shaun's `Luba-MNJR4AS3` / `a1dCWYFLROK` → LUBA_MN → no headlamp, no battery cycles.
  Port fidelity is checkable against the Python and the ioBroker key table.
- **Verifiable now:** the runtime migration correctly `removeCapability`s on a device that
  currently has the flat set (developer's own Luba 2, plus a synthetic test).
- **NOT verifiable without the affected user:** that a Luba 2 Mini genuinely lacks a *side LED*
  (we only have upstream evidence for the headlamp + battery-cycle gap, not side LED). Ship the
  headlamp + battery-cycle gating first; leave side LED on until a diagnostic/telemetry report
  from Shaun's account (or the user's direct confirmation) settles it. State this to the user.
- **NOT verifiable without a Luba 3 in hand:** the exact Luba 3 DeviceType and whether it lands
  in `is_mini_or_x_series`. The mechanism is model-agnostic, so this only affects which side of
  the gate Luba 3 falls on, not whether the mechanism works.

## Options considered (ranked)

1. **(Recommended) Deterministic table, pairing-time + onInit migration.** Effort: medium
   (one new lib file + two call-site changes + migration block + tests). Risk: low — migration
   is guarded and idempotent; BLE/cloud transports untouched. Fixes existing installed base.
2. **Pairing-time only.** Lower effort, but leaves every already-paired device (including the
   reporting user) with the wrong set until they re-pair. Rejected as primary — unacceptable
   for a shipped app with real users.
3. **Telemetry-inferred / lazy capability add.** Highest effort, raciest UX, can't distinguish
   "off" from "absent". Rejected on correctness grounds.

## Open questions for the developer / user

- Does the Luba 2 Mini actually lack a **side LED**, or only the headlamp? (Need Shaun-account
  telemetry or user confirmation — do not gate side LED on assumption.)
- Confirm Luba 3's `deviceName` prefix / productKey so its gate placement is exact (roadmap:
  Luba 3 is a secondary target).

### Decision (2026-07-05): implemented `is_mini_or_x_series()` gating as-is, despite a
### conflicting real-world report

Verified directly against Mammotion-HA's `switch.py` (not just this doc's earlier summary):
`is_mini_or_x_series(device_name)` gates `MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES`
(`manual_light`/`night_light`) **on** for `LUBA_MN` — i.e. upstream's own reference
implementation *keeps* the headlamp switches for the exact device class Shaun's Luba 2 Mini
belongs to. This directly conflicts with this doc's own "concrete report" above (that specific
unit reportedly has no physical headlamp). Separately, the user testing this app's own iOS
companion app also observed no headlight control on a Luba 2 they tested.

Decided to trust the upstream code over the single conflicting report and keep `mow_headlamp`
gated by `isMiniOrXSeries()` exactly as `device_type.py`/`switch.py` define it (so it stays
present for LUBA_MN/LUBA_VP/LUBA_LD and the Yuka mini variants, absent for standard LUBA_2/
LUBA_VA). If this turns out wrong for a specific unit, the likely cause is either a hardware
SKU variant not distinguished by `productKey`/`deviceName`, or a bug in this app's
`actionSetHeadlamp` command mapping rather than the whole class lacking the hardware.

To make that gap diagnosable without guessing again: `device.ts`'s `sendCommandAndSync()` now
logs the resolved model/deviceType/productKey/deviceName whenever a capability command
(including `set_headlamp`) fails, so a real failure from an affected user's diagnostic report
gives us the exact model data needed to reconsider this gate with evidence instead of another
single anecdote.

## Next steps

1. Check `docs/ROADMAP.md` placement — this is a correctness fix for a shipped bug affecting a
   real user; slot it above the P1 widgets work.
2. Developer agent: implement §"Pieces to build" 1–4, add unit tests, bump version + changelog
   per repo convention. Land headlamp + `measure_battery_cycles` gating; keep side LED pending
   confirmation.
3. Follow-up ticket: per-model blade-height/speed/path-spacing limits from `device_config.py`.
