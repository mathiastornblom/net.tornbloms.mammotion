# Start a Mammotion-app-configured task from Homey (run stored schedule now) — analysis & scope

Source of truth: `mikey0000/pymammotion` and `mikey0000/Mammotion-HA` (`main`, read directly via
raw.githubusercontent 2026-07-19 — the GitHub API is gated in this environment, raw file reads are
not), cross-referenced against this repo's own `lib/mammotion/protocol/proto/mctrl_nav.proto`,
`lib/mammotion/protocol/generated/descriptor.ts`, `lib/mammotion/protocol/ScheduleParser.ts`,
`lib/mammotion/commands/LubaCommands.ts`, and `drivers/luba/device.ts`.

This doc builds on facts already established in `docs/SCHEDULING_PLAN.md` (read-only schedule
inspection; write rejected), `docs/ZONE_SELECTION_PLAN.md` (zone-aware `generate_route` + start,
shipped v2.5.48–49), and `docs/ZONE_BOUNDARY_FALLBACK_PLAN.md` (unnamed-zone discovery, v2.5.51).
Read those first — this does not re-derive their protocol facts.

## Why this exists

A forum user configures several mowing **tasks** in the official Mammotion app — each with its own
zones, blade height, speed, and **cutting angle** (e.g. "front of house" split into 3 zones on a
steep slope, each with a fixed angle). They want to trigger these from Homey **in sequence**
(start task 1 → detect finish → auto-start task 2 → …) and, critically, **reuse the settings they
already configured in the app** rather than re-entering blade height / speed / zones / angle in a
Homey Flow card. They note Home Assistant's pymammotion integration "has something like this."

Two independent asks are bundled here and must be scoped separately:

1. **Invoke a specific stored task by name**, applying its app-configured settings verbatim.
2. **Auto-chain** tasks: reliably detect "this job finished" to advance to the next.

### The gap the existing zone action does NOT close

Our shipped `start_mowing_zone` action (and `actionPlanAndStartMowing`) builds a fresh route via
`buildGenerateRouteCommand` (`lib/mammotion/commands/LubaCommands.ts:484`). That builder
**hardcodes** `toward: 0`, `towardIncludedAngle: 0`, `channelMode: 0`, `channelWidth: 25`
(`:505–509`). It therefore **cannot reproduce a per-zone fixed cutting angle at all** — the exact
setting this user relies on for their slope. So "just tell them to Flow-chain the existing zone
action" (option C below) is not merely less convenient; for this user it is functionally incapable
of reproducing their configured mow. This is a confirmed capability gap, not a UX preference.

## What was found (reference source, verified line-by-line)

### 1. A direct "execute stored plan now" command EXISTS (this is HA's feature)

`pymammotion/mammotion/commands/messages/navigation.py:247`:

```python
def single_schedule(self, plan_id: str) -> bytes:
    """Execute a single-run schedule task identified by plan_id."""
    return self.send_order_msg_nav(MctlNav(plan_task_execute=NavPlanTaskExecute(sub_cmd=1, id=plan_id)))
```

This is a **distinct message type** — `NavPlanTaskExecute`, on the `MctlNav.plan_task_execute`
oneof slot — separate from all three things we already send:
- NOT `NavPlanJobSet` (`todev_planjob_set`, the read/create/edit/delete schedule struct, `sub_cmd`
  1/2/3/4 — read-only `sub_cmd=2` is all we ever send today, see `SCHEDULING_PLAN.md`),
- NOT `NavTaskCtrl` (`buildTaskControlCommand`, the bare start/pause/resume/stop/dock),
- NOT `NavReqCoverPath` (`buildGenerateRouteCommand`, the zone plan-route).

It takes **only a `plan_id`**. The device looks up its own stored plan and applies **all** of that
plan's settings itself — zones, blade height, speed, route model, spacing, and cutting angle
(`route_angle` / `toward_included_angle`). We never decode, re-derive, or re-send any of those. This
is the maximally-faithful "run the user's exact configured task" path.

**Home Assistant wires exactly this**, verified end to end:
- `Mammotion-HA/custom_components/mammotion/coordinator.py:1165`:
  ```python
  async def start_task(self, plan_id: str) -> None:
      await self.async_send_and_wait("single_schedule", "todev_planjob_set", plan_id=plan_id)
  ```
  (Note: it sends `plan_task_execute` but **waits on the `todev_planjob_set` echo** as its ack.)
- `Mammotion-HA/custom_components/mammotion/button.py:341–347`: HA builds one **dynamic button per
  stored plan**, keyed by `task_id`, with `press_fn=lambda coord, value: coord.start_task(value)`
  and the button's display name set to the plan's `task_name`. Pressing "Front lawn" runs that
  stored plan. This is precisely the "reuse app-configured task" feature the user saw. (Spino is
  explicitly excluded — `button.py:389–391`: "Spino does not expose a 'start this schedule now'
  command" — confirming Luba/Yuka is where this lives.)

### 2. The command is already fully expressible in our current descriptor — zero regeneration

`lib/mammotion/protocol/proto/mctrl_nav.proto`:
- `:409` `message nav_plan_task_execute { int32 subCmd = 1; string id = 2; string name = 3; int32 result = 4; }`
- `:578` `nav_plan_task_execute plan_task_execute = 53;` (the `MctlNav` oneof slot)

`lib/mammotion/protocol/generated/descriptor.ts` contains **both** the `nav_plan_task_execute`
message (`{subCmd:int32/1, id:string/2, name:string/3, result:int32/4}`) and the `planTaskExecute`
slot in the `MctlNav` oneof. Verified present. **No `.proto`/descriptor change is required** — same
happy result as both zone-selection phases.

### 3. The read-and-replay alternative is real but strictly worse here

`pymammotion/data/model/hash_list.py:264` `class Plan` carries the full stored-plan struct, including
the fields the user cares about: `zone_hashs: list[int]` (`:295`), `route_angle` (`:285`),
`route_model`/`route_spacing` (`:286–287`), `knife_height` (`:281`), `speed` (`:292`),
`edge_mode` (`:283`), `toward_mode`/`toward_included_angle` (`:303–304`). Our `NavPlanJobSet`
descriptor has the matching `zoneHashs` (field 29, repeated fixed64) plus `routeAngle`, `routeModel`,
`routeSpacing`, `knifeHeight`, `speed`, `edgeMode`, `towardMode`, `towardIncludedAngle`
(`mctrl_nav.proto:262–301`). `Plan.zone_hashs` is genuinely consumed upstream
(`hash_list.py:494–499` cross-checks each plan's `zone_hashs` against known area hashes), so the
field is decoded and used, not vestigial.

**But two things make read-and-replay the wrong tool for this feature:**
- Our `ScheduleParser.extractSchedule` deliberately does **not** surface `zoneHashs` today, and
  whether the device populates `zoneHashs` **non-empty in a read echo** is still unverified live
  (the upstream consumption at `:496` does not prove non-emptiness — an empty list simply skips the
  loop). Read-and-replay stakes the whole feature on that unverified decode.
- Even with `zoneHashs` decoded, feeding it into `buildGenerateRouteCommand` reproduces the mow
  only if we **also** thread `routeAngle`/`towardIncludedAngle`/`towardMode`/`routeModel`/
  `routeSpacing` through that builder (which currently hardcodes them to 0). That is re-deriving,
  field by field, exactly what the device already does for itself when handed a `plan_id`.

Direct invoke (§1) needs **only `plan_id`** and sidesteps both problems entirely. Read-and-replay is
more code, more decode risk, and lower fidelity for zero benefit here.

### 4. Enumerating tasks for a name picker — two viable sources

To offer a "pick a task by name" dropdown we need `{plan_id, task_name}` for each stored plan.

- **Already-shipped path (safe primary):** `buildReadScheduleCommand(planIndex)` (`sub_cmd=2`) +
  `ScheduleParser.extractSchedule` already return `planId`, `taskName`, `planIndex`, and
  `totalPlanCount`. Iterate `planIndex = 0 … totalPlanCount-1`, collecting `{planId, taskName}` into
  a cache — same request/response pattern as the existing `requestSchedule()`
  (`drivers/luba/device.ts:523`, `read_schedule` Flow action `driver.ts:150`).
- **Cleaner-if-it-emits path:** `mctrl_nav.proto:459` `message nav_get_all_plan_task { repeated
  plan_task_name_id_t tasks = 1; }` where `plan_task_name_id_t = {string id, string name}`
  (`:454`), on `MctlNav.all_plan_task = 56` (`:581`). This is a single message carrying **all**
  `{id, name}` pairs — ideal for the picker. It is present in our descriptor, but `navigation.py`
  has **no request builder** for it (it appears to arrive as part of the device's plan-sync report,
  not on demand). Treat it as an opportunistic parse-if-seen, not the primary mechanism, until its
  request/trigger is confirmed.

Either way, the picker reuses the **already-working, already-shipped** read path — no new
reverse-engineered read surface.

### 5. Completion detection — there is NO "job finished" status code

Verified against `pymammotion/utility/constant/device_constant.py:272–295` (the full `WorkMode`
enum) and `Mammotion-HA/custom_components/mammotion/lawn_mower.py:207` (the `activity` property):

- The `WorkMode` enum has **no `MODE_JOB_DONE`/`MODE_COMPLETE`**. A finished mow simply transitions
  `MODE_WORKING (13)` → `MODE_RETURNING (14)` → `MODE_READY (11, charging)` / `MODE_CHARGING (15)`.
- HA's `activity` property maps only to MOWING / RETURNING / DOCKED / PAUSED / ERROR — there is **no
  "finished successfully" activity** in the reference either. HA does not distinguish "job complete"
  from "docked for any other reason" at the status level.

So our existing `mower_docked` trigger fires identically for **job complete**, **battery-low
return**, **manual dock**, **rain return**, and **error-then-dock**. It is **not** a reliable
"job finished successfully" signal for auto-chaining on its own.

**The one reliable differentiator is progress.** Our `measure_mow_progress` capability is derived
from `work.area`'s high 16 bits (`lib/mammotion/protocol/TelemetryParser.ts:109`,
`telemetry.progress = (work.area >>> 16) & 0xffff`). A job that genuinely finished reaches
progress **≈100** at the mowing→returning transition (the moment the mower decides to head back,
which is well before it physically arrives at the dock); a battery-low or manual/rain interruption
starts returning with progress **< 100**. Combining "progress reached ~100" with the
mowing→returning transition is the honest "job completed successfully" signal — and it is entirely
derivable from telemetry we already parse.

**Fires on `returning`, not on `charging`** (changed in v2.5.60 from the original design — see the
live diagnostic below): a Flow chaining straight into "start mowing task" for the next job
shouldn't have to wait out the multi-minute physical drive back to the dock before the next task
can start. `mower_docked` (unchanged) still fires only once actually docked, for anything that
cares about physical dock arrival specifically.

## Descriptor coverage — NO regeneration needed (verified)

| Message (`MctlNav` slot, id) | Fields in our descriptor | Needed for |
|---|---|---|
| `nav_plan_task_execute` (`planTaskExecute`, 53) | `subCmd, id, name, result` — complete | direct invoke (§1) |
| `NavPlanJobSet` (`todevPlanjobSet`, 40) | full 38-field struct incl. `planId, taskName, totalPlanNum, PlanIndex, zoneHashs(29, repeated fixed64)` | already used by read path (§4) |
| `nav_get_all_plan_task` (`allPlanTask`, 56) + `plan_task_name_id_t` | `tasks: repeated {id, name}` — complete | optional cleaner picker (§4) |

**Conclusion: zero `.proto`/descriptor changes for any option below.**

## Options, ranked

### Option A (recommended) — direct schedule-invoke + a real "job finished" trigger

**Two primitives, sequencing left to Homey Flows:**

1. **New action `start_mowing_schedule`** with a `task` autocomplete argument (name dropdown),
   mirroring the shipped `start_mowing_zone` card. New builder
   `buildStartScheduleCommand(planId, …)` → `nav.planTaskExecute = { subCmd: 1, id: planId }`
   (byte-for-byte HA's `single_schedule`), routed via the same `isLubaProDevice` receiver /
   `envelope(MsgCmdType.NAV, …)` shape as our other NAV commands. Autocomplete backed by a
   task cache populated by iterating the existing read path (§4). Run listener sends the invoke.
2. **New trigger `mower_job_finished`** fired from `handleTelemetry` on the edge where progress
   reaches ~100 (guard: last-seen progress < threshold → now ≥ threshold, or a
   working→returning/docked transition observed with progress ≥ threshold), de-duped so it fires
   once per job. This is the genuinely new telemetry logic; everything else is plumbing over
   confirmed paths.

**Sequencing stays in Homey Flows.** We ship the two primitives; the user wires
`WHEN mower_job_finished … THEN start_mowing_schedule "task 2"`. True unattended N-step sequencing
that knows *which* task just finished needs a Homey **logic variable** the user manages (Homey Flows
hold no per-mower sequence state, and building a scheduler/queue engine inside the app is out of
scope and duplicates the platform). Document a concrete 3-task example. This is honest about where
the boundary sits: we make each step reliable and faithful; Homey orchestrates the sequence.

Why A: highest fidelity (reuses 100% of app-configured settings incl. the cutting angle we **cannot**
express any other way), lowest decode risk (needs only `plan_id`), zero descriptor change, and it is
a direct port of a feature proven in the HA integration.

### Option B — read-and-replay (decode `zoneHashs` + route params, feed generate-route)

Extend `extractSchedule` to surface `zoneHashs` + `routeAngle`/`towardIncludedAngle`/`towardMode`/
`routeModel`/`routeSpacing`, extend `buildGenerateRouteCommand` to accept them, and replay.
Rejected as the primary: more code, stakes the feature on the unverified "does the read echo carry
non-empty `zoneHashs`" question, and still only *approximates* what direct-invoke does natively. Keep
in reserve only as a fallback **if** live testing shows `single_schedule`/`plan_task_execute` does
not actually trigger a stored plan on real Luba 2/3 firmware.

### Option C — no new code, Flow-chain the existing zone action

Rejected. As shown in "Why this exists," `buildGenerateRouteCommand` hardcodes cutting angle to 0,
so C **cannot** reproduce this user's per-zone fixed-angle mow at all. It also re-enters settings by
hand — the exact thing the user asked to avoid. C remains the honest answer only for a user whose
tasks differ solely by zone selection (which our zone action already covers) — worth stating, but
not this request.

## What is explicitly NOT being built

- **No schedule write/create/edit/delete** (`sub_cmd` 1/3/4) — unchanged from `SCHEDULING_PLAN.md`.
  Direct invoke touches none of these; all three of that doc's rejection reasons (opaque `reserved`
  bytes, `zone_hashs` needing the Maps phase, Homey time-triggers already covering "mow at 09:00")
  remain intact and irrelevant to invoke-by-id.
- **No in-app scheduler/queue engine** — no persistent multi-step sequence state, no cron. Sequencing
  is composed from the `mower_job_finished` trigger + `start_mowing_schedule` action in Homey Flows.
- **No `zoneHashs`/route-param decode from the read echo** (that is Option B, held in reserve only).
- **No cutting-angle / route-model / spacing arguments** added to the zone or start cards — direct
  invoke makes them unnecessary; exposing them as free-form Flow args is a separate, larger scope.
- **No `nav_get_all_plan_task` request builder** — parse-if-the-device-emits-it only; the iterate-by-
  index read path is the committed enumeration mechanism.
- **No Spino support** for this feature (reference confirms Spino has no execute-now command).
- **No new resume/breakpoint decision tree** — same deferral as the zone docs.

## Verification — what can and cannot be checked before shipping

- **Verifiable now (unit tests, `scripts/*.test.mjs`, same rig as `test:schedule`):** round-trip
  encode/decode of `buildStartScheduleCommand` (`planTaskExecute {subCmd:1, id}`) against our
  descriptor; the task-enumeration cache built from iterated `extractSchedule` reads against
  synthetic multi-plan fixtures; and the `mower_job_finished` edge/de-dupe logic against a synthetic
  progress-then-dock telemetry sequence.
- **NOT verifiable without live hardware/account (state plainly, same class as the Aliyun legacy
  subsystem):** that `plan_task_execute {subCmd:1, id}` actually starts the referenced stored plan on
  real Luba 2/3 firmware (vs. the HA path we are porting, which is proven only in HA's own field
  use); that the `todev_planjob_set` echo arrives as a usable ack; that iterating `read_plan` by
  index returns every stored plan with a stable `plan_id`↔`task_name` mapping; and that real
  finished-job telemetry reaches progress ≈100 before the returning→docked transition on this
  hardware (the crux of completion detection). The forum reporter with the 3-zone slope setup is the
  exact-fit live-test partner — a single "start task X by name" invoke plus one observed
  job-finished transition is the go/no-go.
- **NOT verifiable:** `aliyun_legacy` behavior for either the invoke or the multi-read enumeration
  (no live account for that path) — attempt-and-degrade, same standing caveat.

## Effort / risk estimate

- **Low code volume, low protocol risk.** One tiny command builder (descriptor already complete),
  one enumeration cache reusing the shipped read path, one autocomplete card cloned from
  `start_mowing_zone`, one telemetry-edge trigger, and i18n across all 13 languages (new card
  title/hint, `task` arg placeholder, trigger title — audit per the `ROADMAP.md` i18n note).
- **Highest residual risk is the unverifiable-without-hardware claim** that `plan_task_execute`
  triggers a stored plan — mitigated by it being a direct port of a shipped HA feature and by
  Option B being available as a fallback if it fails live.
- **Completion detection is the second risk**: progress-based finished-detection is a heuristic
  (there is no status code), so tune the threshold conservatively and de-dupe hard to avoid a false
  "finished" advancing the chain mid-job.

## Recommendation — worth building: YES (Option A)

Build Option A. It closes a **confirmed capability gap** (per-zone cutting angle, which no existing
card can express), directly reuses every app-configured setting exactly as the user asked, is a
faithful port of a proven HA feature, needs **zero descriptor changes**, and carries low code
volume. The auto-advance the user wants is composed from the new `mower_job_finished` trigger plus
the new `start_mowing_schedule` action in ordinary Homey Flows — we deliberately do **not** build an
in-app scheduler. Option C is inadequate for this request; Option B is a documented fallback only.

## Next steps

1. Slot into `docs/ROADMAP.md` — a feature request from a live forum user that also fixes a real
   capability gap (cutting angle); place alongside the zone-selection fixes, above P1 widgets.
2. Developer agent — Phase 1: `buildStartScheduleCommand` + task-enumeration cache (iterate the
   existing read path) + `start_mowing_schedule` autocomplete card + unit tests. Keep the read-only
   `read_schedule` action and the `NavPlanJobSet` read path untouched.
3. Developer agent — Phase 2: `mower_job_finished` trigger (progress-edge + transition, de-duped) in
   `handleTelemetry`; document a concrete 3-task Homey Flow-chaining recipe using a logic variable.
4. i18n audit across all 13 languages for the new card + trigger + arg strings.
5. Live-verify with the forum reporter: one "start task by name" invoke on real hardware, and one
   observed job-finished transition. This is unverifiable without that device — exactly like the
   Aliyun legacy subsystem. If invoke fails live, fall back to Option B (read-and-replay) using the
   `zoneHashs`+route-param decode, and re-verify.

## Live verification result (v2.5.58, forum user "Örjan", Luba 2 Pro)

**Both open questions from the "NOT verifiable without live hardware" section above are now
resolved, positively.** Diagnostic logs (report IDs `53c8a6a3-7c5a-4150-8991-e440cb0e9036` and
`f09213f3-7e48-4f65-9bce-c9b39f021e67`) show `plan_task_execute {subCmd:1, id}` correctly invoked
the stored task "Kortsida mot Ivan stripe" on real firmware — it mowed that task's own zone at its
own angle — and the mower's progress reached exactly 100 right as status transitioned
returning→charging, satisfying `mower_job_finished`'s firing threshold in a real run. No fallback to
Option B was needed.

The same diagnostics surfaced a real, unrelated bug in the *other* verifiable-by-unit-test half of
this feature: the task-enumeration cache only ever returned a single stored plan (`planIndex=0`)
even though the device correctly reported 15 stored tasks in every response. Root cause: `sendRaw`'s
duplicate-command guard keyed on the command label alone (`'read_schedule'`), and
`runScheduleRefresh()`'s sequential per-`planIndex` reads all shared that one label — so every read
after the first was silently swallowed as a "duplicate" within the guard's 1.5s window, and
`waitForScheduleResponse()` for `planIndex=1` then timed out waiting for a request that was never
actually sent. Fixed in v2.5.58 by suffixing the label with `planIndex` (`read_schedule:${planIndex}`),
mirroring the fix already used for `get_hash_response`/`synchronize_hash_data` in the boundary-zone
discovery path (`drivers/luba/device.ts`). This was a bug in the surrounding transport plumbing, not
in `extractSchedule`/the enumeration-cache logic itself — the existing unit tests didn't (and
couldn't, without a fake transport) cover `sendRaw`'s dedup guard.

**A second, deeper bug surfaced immediately after v2.5.58 shipped**: the same tester's next
diagnostic (log `58c5a8db-de81-4fdb-a1f7-b61837607232`) showed the picker now listing 15 entries —
but all 15 were the *same* task name. Every `read_schedule:N` request was now genuinely being sent
(the v2.5.58 fix worked), but decoding the raw bytes showed each request's `NavPlanJobSet` submessage
was byte-identical regardless of `planIndex` — the index was never actually reaching the device.
Root cause: `buildReadScheduleCommand` (`lib/mammotion/commands/LubaCommands.ts`) built the request
object as `{ subCmd: 2, planIndex }`, but the proto field is declared `int32 PlanIndex = 24;`
(capitalized, `mctrl_nav.proto:286`) — protobufjs keeps field names exactly as declared, it does not
camelCase them, so the lowercase `planIndex` key silently didn't match anything and was dropped
during encoding. Every request left the field unset, so the device always answered with its first
stored plan. The exact same capitalized-field gotcha already bit `extractCommDataAck`'s `Hash` field
in the boundary-zone discovery path (see that test's name in `boundary-zone-discovery.test.mjs`) —
this codebase's protos mix cases inconsistently and it is not obvious from the wire format alone.
Fixed in v2.5.59 by encoding `PlanIndex: planIndex` (capital P) instead. Also hardened
`scripts/schedule-roundtrip.test.mjs` with a test that decodes the built request and asserts
`PlanIndex` actually round-trips for several index values — the previous test only asserted
`subCmd === 2` and would not have caught this.

**Task-chaining design gap surfaced on v2.5.59** (log `087258b1-d66f-43cd-b16b-146d2f5f0c55`):
Örjan built exactly the Flow this feature was designed for — `mower_job_finished` → "Start mowing
task" for the next job — and reported the next task never started; the mower just drove to the
charging station instead. Clarifying with the maintainer confirmed the actual intent: the trigger
should fire the moment the mower **decides** to head back (mowing→returning, progress already
~100), not once it's physically **arrived** and started charging. The original design fired on the
returning→charging transition specifically because that felt like the safer "job is truly over"
signal, but in practice this means the next task in the chain can't start until the mower completes
its entire physical drive back to the dock — several minutes of dead time for no benefit, since
progress reaching ~100 at the mowing→returning transition is already the reliable "job complete"
signal (see above); nothing more is learned by waiting for the dock.

Fixed in v2.5.60: moved the `mower_job_finished` firing logic from the `charging` branch to the
`returning` branch in `updateMowerStatus()`. Also fixed a related ordering bug while doing this:
`handleTelemetry()` previously called `updateMowerStatus()` *before* folding the current tick's
`state.progress` into `highestMowProgressThisJob` — harmless when progress crossed the threshold on
an earlier tick (as it did in Örjan's log, where progress was already 99 the tick before the
status flip), but a real risk of a missed fire if progress and the mowing→returning transition ever
land in the exact same telemetry tick, since `updateMowerStatus()` only evaluates the threshold
once per transition (it early-returns on repeat statuses) and would read the stale pre-tick value.
Now `state.progress` is applied first. `mower_docked` is unchanged and still fires only once
actually charging, for anything that specifically cares about physical dock arrival.

## `task_name` token added (v2.5.61)

Also requested by Örjan (same diagnostic thread, log `087258b1-d66f-43cd-b16b-146d2f5f0c55`): with
several tasks queued, a Flow needs to know *which* job just finished to route to the right next
action. There's no per-job identifier in telemetry to key off — `work.plan` stays `0` throughout a
real job in every captured diagnostic — so instead of trying to parse job identity out of telemetry,
`mower_job_finished` now carries a `task_name` token sourced from our own side: `actionStartSchedule()`
(`drivers/luba/device.ts`) records the task name it was invoked with in `lastStartedTaskName`, which
gets passed through as the token when the job finishes and is then cleared. It's also cleared by
`actionPlanAndStartMowing()` (the ad-hoc zone/route start, a different kind of job) so that a job
started some other way — the official Mammotion app, the mower's own onboard weekly scheduler —
reports an empty token instead of a stale or wrong name. This is a deliberate best-effort scope: it
only identifies jobs that were themselves started through our "Start mowing task" action.
