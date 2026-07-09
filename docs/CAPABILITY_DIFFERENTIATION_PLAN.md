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

> NOTE (2026-07-09): the reading in this section turned out to be the root cause of a shipped
> bug. `is_mini_or_x_series` is **not** a headlamp-presence predicate — it gates a
> mini/X-series-specific manual/night lighting-*mode* UI. See the 2026-07-09 decision below,
> which supersedes the headlamp half of the 2026-07-05 decision.

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

### Decision (2026-07-09): the `isMiniOrXSeries()` headlamp gate is wrong — it measures the
### wrong thing. Gate `mow_headlamp` on "is a mower" (all Luba/Yuka), not on mini/X-series.

Trigger: the app owner's own **real Luba 3** (`productKey uY54W5rM8YH`, `deviceName` prefix
`Luba-VA*` → `DeviceType.LUBA_VA` / "HM442") lost its `mow_headlamp` toggle. That unit
physically has a front headlamp and the toggle previously worked; `migrateCapabilities()`
re-strips it on every `onInit` because `LUBA_VA` is not in `isMiniOrXSeries()`. This is a
second, independent, stronger contradiction of the 2026-07-05 call than the original Luba 2
Mini anecdote — from the maintainer's own hardware, not a third-party field report.

**Root cause (verified from source): the 2026-07-05 decision mapped the wrong upstream signal.**
Re-reading the actual code (not the earlier summary) shows HA has **three** distinct light
controls, driven by **three different pymammotion command builders on two different protobuf
buses** — they are not one "headlamp" feature with an index:

- `side_led` — `SWITCH_ENTITIES` (base, **every** mower, unconditional). Setter
  `coordinator.async_set_sidelight` → `MessageSystem.read_and_set_sidelight(is_sidelight, operate)`
  → `MctlSys(todev_time_ctrl_light=TimeCtrlLight(enable=0/1, …))`. This is a **SYS**
  (`MctlSys`) command, verified in `pymammotion/mammotion/commands/messages/system.py:131`.
- `night_light` — `MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES` (gated to mini/X-series). Setter
  `async_set_night_light` → `MessageMedia.set_car_light(on_off)` →
  `SocMul(set_lamp=SetHeadlamp(set_ids=1121, lamp_power_ctrl=1, lamp_ctrl=power_ctrl_on/off))`.
  Docstring: *"set whether light is on during the night during mowing … auto night on"* — a
  **night auto-lighting MODE**, not a physical-lamp-presence flag
  (`pymammotion/mammotion/commands/messages/media.py:65`).
- `manual_light` — `MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES` (gated to mini/X-series). Setter
  `async_set_manual_light` → `MessageMedia.set_car_manual_light(manual_ctrl)` →
  `SocMul(set_lamp=SetHeadlamp(set_ids=1125/1127, lamp_power_ctrl=2, lamp_manual_ctrl=…))` —
  **manual** on/off of that same lamp (`media.py:86`).

Citations (read directly this pass, not from the earlier paraphrase):
`Mammotion-HA/custom_components/mammotion/switch.py` — `SWITCH_ENTITIES` (side_led +
rain_detection, added to every mower), `MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES`
(manual_light + night_light), gated only by
`if DeviceType.is_mini_or_x_series(device_name):`; `Mammotion-HA/…/coordinator.py:771–805`
(the three setters); `pymammotion/…/messages/media.py:58–97` and `…/messages/system.py:131–154`
(the command builders); `pymammotion/utility/device_type.py` — `is_mini_or_x_series` returns
YUKA_MINI/MINI2/MINIV/ML, YUKA_VP, LUBA_MN/VP/LD, and `supports_battery_cycle_count` excludes
YUKA_MINI/ML/MINIV/MN100/MN101, LUBA_MN/LD/LA/MB.

So `is_mini_or_x_series` gates a **manual + night-auto lighting-MODE UI** that HA only wired up
for the mini/X-series product line. It is **not** a "has a physical front headlamp" predicate.
The 2026-07-05 decision read "upstream keeps manual_light/night_light for LUBA_MN" as "LUBA_MN
has a headlamp and standard Luba 2 / Luba 3 do not" — that inference does not follow from the
source. Whether a full-size Luba's front headlamp is even reachable through the same MUL
`SetHeadlamp` message, the SYS `side_led`/`TimeCtrlLight` path, or a path HA simply doesn't
expose, is not determinable from `switch.py` alone.

**Vendor ground-truth (spec pages / official copy) — physical front headlamp presence:**

- **Luba 2 AWD** (= `LUBA_2` / "Luba-VS"): *"The front headlight … can be activated through the
  app so that the robotic lawnmower can also be seen in the dark."* — Mammotion LUBA 2 AWD
  product copy (via basic-tutorials.com / easylawnmowing.com reviews citing the official spec).
  **Has a headlamp. Currently stripped by our gate → BUG.**
- **Luba 3 AWD** (= `LUBA_VA` / "HM442"): LED headlight confirmed by Mammotion's own product
  page (`us.mammotion.com/products/luba-3-awd-robot-lawn-mower`) and TechRadar's review, plus
  the maintainer's own unit. **Has a headlamp. Currently stripped by our gate → BUG.**
- **Luba (2) Mini AWD** (the mini line, `LUBA_MN` / "HM430" family): *"a powerful LED headlight
  allowing for effective night operation"* — easylawnmowing.co.uk Luba Mini AWD review of the
  official spec. **Has a headlamp. Currently kept (in mini/X-series) → already correct.**

All three target models physically have a front headlamp. The Luba line uniformly ships one.
(The lone 2026-07-05 "no headlamp on a Luba 2 Mini 1000" anecdote is not reproduced by the
vendor's own mini copy; since we are **keeping** the headlamp for `LUBA_MN` either way, it is
not load-bearing for this fix and needs no resolution here.)

**Corrected recommendation:**

1. Stop gating `mow_headlamp` on `isMiniOrXSeries()`. Add a new predicate — described, not
   implemented — e.g. `hasHeadlamp(deviceType: DeviceType): boolean` that returns `true` for
   every Luba-family and Yuka-family **mower** type and `false` for RTK base stations,
   swimming-pool robots, and `UNKNOWN`. Mirror pymammotion's own groupings:
   `is_luba_type()` (LUBA, LUBA_2, LUBA_VP, LUBA_MN, LUBA_LD, LUBA_VA, LUBA_HM, LUBA_ME,
   LUBA_MB, LUBA_LA, CM900) `||` `is_yu_ka_type()` (all Yuka). Since this app only pairs
   Luba-family devices today, the practical effect is "present on every device this driver
   pairs," but the predicate stays structured/forward-safe for the Yuka/RTK roadmap.
2. In `capabilitiesForModel()`, change the `mow_headlamp` branch from
   `isMiniOrXSeries(deviceType)` to `hasHeadlamp(deviceType)`. No other branch changes.
3. **Do NOT edit `isMiniOrXSeries()` itself** — it is a faithful 1:1 port of
   `device_type.is_mini_or_x_series()` and should stay accurate for the day we split the real
   manual-light / night-light mode feature out (see follow-up below). But **fix its JSDoc**: the
   current comment *"These models do not have a headlamp"* is backwards and is what seeded this
   bug — it should say these are the models for which upstream exposes the separate
   manual/night-auto lighting-mode switches.
4. **Also fix the `capabilitiesForModel()` JSDoc** line "mow_headlamp: mini/X-series only" and
   the two similar comments in `device.ts` (`onInit` around line 96, `migrateCapabilities`
   around line 128) that assert a Luba 2 Mini "has no headlamp."
5. `measure_battery_cycles` gate (`supportsBatteryCycleCount()`) is **verified correct against
   source this pass** — its exclusion list matches `device_type.py` exactly. No change. This
   correctly keeps cycles for LUBA_2/LUBA_VA and drops them for LUBA_MN.
6. `mow_side_led` and `mow_rain_protection` stay **ungated** — verified: both are in HA's base
   `SWITCH_ENTITIES`, added to every mower unconditionally. No change.

**In-place fix for existing users is automatic:** `migrateCapabilities()` already reconciles on
every `onInit` via `capabilitiesForModel()`, so once the predicate changes, already-paired
LUBA_2/LUBA_VA devices `addCapability('mow_headlamp')` on next launch with no re-pair. This is
exactly what restores the maintainer's Luba 3. (The `scripts/device-type.test.mjs` expectations
that currently assert LUBA_2/LUBA_VA lose `mow_headlamp` must be updated in the same pass — they
encode the now-wrong behaviour.)

**Follow-up flagged, explicitly OUT OF SCOPE for this doc (do not fold into the gate fix):**
Our `mow_headlamp` (`buildSetHeadlampCommand`, `set_ids=0`) and `mow_side_led` (`set_ids=1`)
send `SocMul.set_lamp = SetHeadlamp` with `set_ids` values of **0 / 1**, which match **none** of
the upstream shapes: upstream's side LED is a **SYS `TimeCtrlLight`** message (not MUL at all),
and its MUL lamp commands use `set_ids` **1121 / 1125 / 1127** with specific
`lamp_power_ctrl`/`lamp_manual_ctrl` values for the night-auto vs manual modes. So our two
toggles are the app's own invented scheme, not a port of any of the three upstream commands.
The maintainer reports the headlamp toggle *worked* on his Luba 3, so `set_ids=0` is apparently
functional there — but this is **inferred from one field report, not verified from source**, and
`mow_side_led`'s `set_ids=1` is unverified end-to-end. A separate ticket should reconcile our
command shape with pymammotion's three-command model (`read_and_set_sidelight` /
`set_car_light` / `set_car_manual_light`) and decide whether to split the capabilities. Gating
presence (this doc) and command correctness (that ticket) are independent; do not block the
presence fix on it.

**Confidence per model/capability:**

| Capability | Luba 2 (`LUBA_2`) | Luba 2 Mini (`LUBA_MN`) | Luba 3 (`LUBA_VA`) |
|---|---|---|---|
| `mow_headlamp` present | **YES** — vendor spec (headlight app-activatable). *Currently NO → fix.* Confidence: high (vendor-confirmed) | **YES** — vendor mini review + upstream keeps it. *Currently YES → unchanged.* Confidence: high | **YES** — vendor page + owner's own unit. *Currently NO → fix.* Confidence: high (vendor + owner) |
| `mow_side_led` present | YES (upstream base) | YES | YES — verified-from-source (unconditional). Confidence: high |
| `mow_rain_protection` present | YES (upstream base `rain_detection`) | YES | YES — verified-from-source (unconditional). Confidence: high |
| `measure_battery_cycles` present | **YES** (fixed battery) | **NO** (removable pack) | **YES** (fixed battery) — verified-from-source. Confidence: high — no change |

Command-shape correctness (`SetHeadlamp set_ids=0/1`) for **any** model: genuinely
ambiguous / not verified from source — tracked as the separate follow-up above.

**Reconciliation with the 2026-07-05 decision:** partially **confirmed**, partially
**superseded**. Confirmed: keep `mow_headlamp` for `LUBA_MN` and the mini/X-series (vendor mini
copy backs it; the no-headlamp anecdote is not acted on). Superseded: its implicit acceptance
that standard `LUBA_2` and `LUBA_VA` lack a headlamp — that came from misreading
`is_mini_or_x_series` as a hardware-presence predicate when it actually gates a mini/X-specific
lighting-*mode* UI. Vendor spec pages plus the maintainer's own Luba 3 overturn that half.

## Next steps

1. Check `docs/ROADMAP.md` placement — this is a correctness fix for a shipped bug affecting a
   real user; slot it above the P1 widgets work.
2. Developer agent: implement §"Pieces to build" 1–4, add unit tests, bump version + changelog
   per repo convention. Land headlamp + `measure_battery_cycles` gating; keep side LED pending
   confirmation.
3. Developer agent (2026-07-09 decision): replace the `mow_headlamp` gate with `hasHeadlamp()`,
   fix the stale JSDoc/comments in `deviceType.ts` and `device.ts`, and update
   `scripts/device-type.test.mjs` so LUBA_2/LUBA_VA keep `mow_headlamp`. Verify the maintainer's
   Luba 3 regains the toggle after a restart (migration path).
4. Follow-up ticket: reconcile the app's `SetHeadlamp(set_ids=0/1)` command shape with
   pymammotion's three-command lighting model (`read_and_set_sidelight` / `set_car_light` /
   `set_car_manual_light`); decide whether to split `mow_headlamp`/`mow_side_led` accordingly.
5. Follow-up ticket: per-model blade-height/speed/path-spacing limits from `device_config.py`.
