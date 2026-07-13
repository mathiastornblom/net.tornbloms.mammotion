# LED Ring status feedback — plan

## Why this exists

The maintainer wants Homey's built-in LED Ring (physical ring on Homey Pro) to give
at-a-glance visual feedback about mower state, with each behavior individually toggleable:

1. Spinning **red** animation when an emergency stop / fault has occurred.
2. A "cool screensaver" **green** animation (evoking grass) while a mower is actively cutting.
3. A pulsing **blue** animation while a mower is charging.

This is a nice-to-have cosmetic feature. It is **cosmetic only** — it must never affect,
block, or gate the app's core function (mower control), and must silently do nothing on the
majority of Homey hardware that has no controllable LED ring.

## What was found (verified in this repo, not inferred)

### 1. `platformLocalRequiredFeatures` correction — CONFIRMED CORRECT, do NOT use it

The correction flagged to the user is right. Evidence:

- `net.tornbloms.mammotion` is a general mower-control app. The LED ring is unrelated to its
  core purpose, so nothing about install eligibility should depend on it.
- `platformLocalRequiredFeatures: ["ledring"]` in the manifest would **block the entire app
  from installing** on any Homey lacking a controllable LED ring — that includes current
  Homey Pro 2023, Homey Cloud, Homey Bridge, and any non-early-2019 hardware. That would be
  a severe regression for a shipped, live app with an existing community. Unacceptable.
- The manifest already declares `"platforms": ["local"]` (`.homeycompose/app.json`), which
  is as far as the manifest should go.

**Correct approach: runtime feature-detection, silent no-op when absent.** Confirmed viable
against the typings in this repo:

- `node_modules/@types/homey/lib/Homey.d.ts:104-105` types `ledring: ManagerLedring` as a
  **non-optional** property. So `this.homey.ledring` is always type-present; TypeScript will
  not force an optional-chain. Detection cannot rely on the type being optional.
- `node_modules/@types/homey/manager/ledring.d.ts`: every method
  (`createAnimation`, `createSystemAnimation`, `createProgressAnimation`,
  `registerAnimation`, `registerScreensaver`) is `Promise`-returning and documented as
  requiring the `homey:manager:ledring` permission. On hardware without a controllable ring
  these reject/throw rather than being statically absent.

**Recommended detection (belt-and-suspenders):**
- Guard with `if (this.homey.ledring == null) return;` (cheap; covers hubs where the manager
  object itself is absent at runtime despite the non-optional type — treat the type as
  optimistic).
- Wrap the **first** `createSystemAnimation`/`createAnimation` call in `try/catch`. On any
  throw/reject, set an internal `ledringAvailable = false` flag and permanently no-op every
  subsequent call for the app's lifetime. Log once at `this.log()` level (not `error`) —
  "LED ring unavailable, disabling LED status feedback" — never surface it to the user.
- Because the property is typed non-optional, use `this.homey.ledring as ManagerLedring |
  undefined` at the single access point, or a small `getLedring(): ManagerLedring |
  undefined` helper, to satisfy strict mode without an `any` or a non-null `!`.

The `homey:manager:ledring` permission **must** be added to the `permissions` array in
`.homeycompose/app.json` (currently just `["homey:wireless:ble"]`; `app.json` is generated
from compose, so edit the compose source). Adding a permission does not gate installation the
way `platformLocalRequiredFeatures` does — it only requests capability access.

### 2. "Emergency stop" detection is NOT reliable today — this is the main caveat

There is **no confirmed, reliable emergency-stop / wheel-lift signal** in this codebase. This
is the still-open subject of `docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md`: `sys_status` has
never changed during a captured stop, `sensor_status`/`self_check_status` have no confirmed
wheel-lift bit, and `toapp_err_code` has never fired in any capture. Driving the red
animation off a promise of true "emergency stop" detection would be dishonest and unreliable.

**What IS confirmed and usable:** the existing error state. `device.ts`'s `updateMowerStatus`
(around line 761) already sets `alarm_generic` via `isErrorMode(rawMode)` and produces
`mower_status === 'error'` for work modes 17 (MODE_LOCK), 23, 37, 38 (see
`lib/mammotion/protocol/WorkModeStatus.ts`). MODE_LOCK(17) is the one upstream-confirmed hard
safety/lock code (verified against Mammotion-HA's `lawn_mower.py`).

**Recommendation:** drive the red animation off the **already-shipped error status**
(`mower_status === 'error'` / `alarm_generic === true`), and **name the setting accordingly**
— "mower error/fault", not "emergency stop", to avoid implying detection the app doesn't have.
Document in the setting hint and here that auto-recovering wheel-lift stops that never surface
as an error mode will **not** trigger the red ring until the WHEEL_LIFT investigation lands a
confirmed signal. If that investigation later adds a dedicated e-stop signal, the red
animation trigger is a one-line change to also fire on it. This dependency is a **soft
caveat, not a blocker** — the feature ships usefully on the confirmed error state alone.

### 3. Settings belong at app level, not per-device — CONFIRMED

The LED ring is single, shared, whole-hub hardware. Per-device settings would be wrong (N
mowers, one ring). The app already has the exact app-level settings pattern to reuse:

- `settings/index.html` — a plain HTML settings page using `Homey.get(key, cb)` /
  `Homey.set(key, value)`. The existing `crashReporting` checkbox is the template to copy.
- Read side: `this.homey.settings.get('<key>')` (used in `app.ts` for `crashReporting`), and
  `this.homey.settings.on('set', ...)` to react to live toggle changes.
- i18n: settings labels/hints live under `settings.*` in `locales/en.json` (line 52+) and
  must be mirrored across all 13 locale files (see the i18n-drift note in `ROADMAP.md`).

Three new boolean settings: `ledEmergencyStop`, `ledMowing`, `ledCharging`.
**Default: all OFF.** Shared hardware that lights up unprompted after an app update would
surprise users; opt-in is the conservative choice for a cosmetic feature. (Contrast with
`crashReporting`, which defaults on — different risk profile.)

### 4. Screensaver vs. immediate feedback animation — use feedback, not screensaver

These are two different mechanisms in the LED ring API and the requested behaviors want the
first one:

- **Immediate feedback animation** (`createSystemAnimation`/`createAnimation` +
  `.start()`/`.stop()`, `duration: false` for indefinite): plays *now*, while a condition
  holds, regardless of whether Homey is idle. This is what "show green **while** mowing"
  requires.
- **Screensaver** (`registerScreensaver` + a `.homeycompose/screensavers/<name>.json`
  manifest entry): only ever shown when Homey is idle **and** the user has manually selected
  it in Homey's LED Ring settings. It cannot represent live state and the user might never
  pick it. Wrong tool for all three behaviors.

**Recommendation:** implement all three as immediate feedback animations with
`duration: false`, `.start()` on entering the state and `.stop()` on leaving it. Do **not**
register screensavers. The maintainer's phrase "cool screensaver green animation" describes
the *visual style* (ambient, flowing), not the screensaver mechanism — a custom
`createAnimation` frame set with a rotating/wave green gradient satisfies the intent. (A green
grass screensaver could be a separate future nicety, but it is explicitly out of scope here.)

### Be a good LED-ring citizen (priority + persistence)

The ring is shared across **all** Homey apps and Homey's own idle clock/screensaver. A
persistently-running animation occupies the ring and suppresses everything else, which is
antisocial. Mitigations, baked into the design:

- Use priority **`INFORMATIVE`** for the mowing (green) and charging (blue) ambient
  animations, and **`FEEDBACK`** (elevated, but NOT `CRITICAL`) for the error (red)
  animation. `CRITICAL` is reserved for genuine alerts and would stomp other apps — do not
  use it.
- Only run an animation **while its condition actually holds**; call `.stop()` the moment the
  aggregate state leaves that condition so the ring returns to normal (idle clock / other
  apps' feedback). Never leave an animation running "just in case".
- All three toggles OFF (the default) means the app touches the ring zero times.

## Design: aggregation across multiple mowers

The ring is one device; the app can have several `LubaDevice` instances. Need a single
app-owned aggregator.

**Priority order (highest wins):** `error` > `mowing` > `charging` > (none).
`returning`, `paused`, `idle` map to **no animation**. Rationale: a fault anywhere is the most
important thing to surface; active cutting is the "app is doing its job" signal; charging is
ambient/low-stakes.

**Aggregation rule:** the animation shown = the highest-priority state present across **any**
paired mower, filtered by that state's toggle being enabled. Example: mower A charging + mower
B mowing → green (mowing outranks charging). Mower A error + mower B mowing → red. If the
winning state's toggle is disabled, fall through to the next-highest **enabled** state (e.g.
error toggle off but mowing on, and a mower is both errored and another mowing → show green).

**Ownership / wiring:**
- New module `lib/mammotion/ledring/LedRingController.ts` (a stateful class, per coding
  conventions), instantiated once in `app.ts` `onInit` and held on the app instance. It owns:
  the availability flag, the created animation objects, the current-displayed state, and the
  three toggle values (seeded from `this.homey.settings`, updated via a `settings 'set'`
  listener).
- The controller exposes `reportStatus(deviceId: string, status: MowerStatus | null)` and
  keeps a `Map<deviceId, MowerStatus>`. `null` / device deletion removes the entry. On every
  report it recomputes the winning state and starts/stops animations as needed (no-op if the
  winning state is unchanged).
- `LubaDevice` calls into it. `device.ts` already has the single choke point:
  `updateMowerStatus` (around line 761) runs on every status transition. Add a call there to
  the app-level controller (reach the app via `this.homey.app` cast to the app type, matching
  how the app is accessed elsewhere), plus a `reportStatus(id, null)` in `onDeleted`/`onUninit`
  so a removed or offline mower stops pinning an animation.
- The controller must debounce/coalesce: telemetry can arrive rapidly, so recompute is cheap
  but `.start()/.stop()` calls should only fire on an actual displayed-state change.

## Animation definitions (starting point, tune during implementation)

- **Error (red):** `createSystemAnimation('colorwipe' or a custom spinning frame set)` in
  red, `priority: 'FEEDBACK'`, `duration: false`, with `rpm` set for the "spinning" feel via
  `createAnimation`. A hand-rolled `createAnimation` with a red arc rotating around the 24
  LEDs gives the clearest "spinning" look; `rpm` in `options` drives rotation.
- **Mowing (green):** custom `createAnimation`, 24-frame green gradient/wave that flows around
  the ring, `priority: 'INFORMATIVE'`, `duration: false`, moderate `rpm`/`fps`. Frames are
  arrays of 24 `{r,g,b}` (0–255).
- **Charging (blue):** `createSystemAnimation('pulse', { priority: 'INFORMATIVE', duration:
  false })` in blue — the built-in `pulse` is exactly the requested effect and cheapest to
  build. (System animations take a color via the system-animation type; if `pulse` can't be
  recolored, fall back to a custom breathing-blue `createAnimation`.)

Keep frame counts small (memory-constrained Homey 3s — though note LED ring hardware only
exists on Homey Pro, so this runs on Pro-class hardware; still, keep it lean).

## What is explicitly NOT being built (and why)

- **No `platformLocalRequiredFeatures` manifest flag** — would block install on most current
  hardware for a cosmetic feature. Runtime detection instead. (Core correctness point.)
- **No screensaver registration** — wrong mechanism for live-state feedback; the three
  behaviors are immediate animations. A green "grass" idle screensaver is a possible separate
  future item, not this.
- **No per-device LED settings** — the ring is shared hardware; app-level only.
- **No `CRITICAL` priority** — reserved; antisocial toward other apps. Max is `FEEDBACK`.
- **No new dependency** — the LED ring API is built into the Homey SDK (`this.homey.ledring`).
  Zero bundle-size cost. (Weighed per the memory-constraint rule: nothing to add.)
- **No claim of true emergency-stop detection** — red is driven by the confirmed existing
  error status only; wheel-lift auto-recovery stops remain uncovered pending
  `WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md`.

## What can and cannot be verified before shipping

- **Cannot fully verify without Homey Pro hardware that has a controllable LED ring**
  (early-2019-or-earlier Pro, or whatever the developer has). The animation look, the
  start/stop transitions, and the runtime feature-detection no-op path on non-ring hardware
  all want a real hub to confirm. State this limitation plainly, same posture as the Aliyun
  legacy subsystem: the logic is portable and testable in isolation, but the ring
  interaction itself is hardware-gated.
- **Can verify statically:** the aggregation logic (pure function over a `Map` of states —
  unit-testable), the settings plumbing, and that the app builds/validates with the new
  permission.

## Next steps (for the developer agent)

1. Add `homey:manager:ledring` to `permissions` in `.homeycompose/app.json`.
2. Add three checkboxes (`ledEmergencyStop`, `ledMowing`, `ledCharging`, default OFF) to
   `settings/index.html`, copying the `crashReporting` pattern; add `settings.led_*` i18n keys
   to `locales/en.json` and mirror to all 13 locales.
3. Create `lib/mammotion/ledring/LedRingController.ts` (availability detection, animation
   lifecycle, toggle state, per-device state `Map`, priority aggregation, start/stop only on
   change).
4. Instantiate it in `app.ts` `onInit`; wire a `this.homey.settings.on('set', ...)` listener
   to keep toggles live.
5. Call `reportStatus(...)` from `device.ts` `updateMowerStatus` and clear it in
   `onDeleted`/`onUninit`.
6. Keep the red trigger bound to the existing `mower_status === 'error'` / `alarm_generic`
   signal; add a `// TODO` referencing `WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md` for the future
   dedicated e-stop signal.
7. `homey app validate`; manual i18n audit; note in the PR that ring behavior is unverified
   without LED-ring hardware.

## Roadmap fit

Not currently in `docs/ROADMAP.md`. It is a maintainer-requested nice-to-have, comparable in
size/priority to the P1 dashboard-widgets item. Suggest adding it under **P2** (medium value,
low-to-medium complexity, no external protocol risk). Confirm with the maintainer before
scheduling.
