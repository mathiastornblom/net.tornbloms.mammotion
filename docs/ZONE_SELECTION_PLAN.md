# Zone selection & "plan route before start" — analysis & scope

Source of truth: `mikey0000/pymammotion` (cloned at the scratchpad path used during research) and
`mikey0000/Mammotion-HA` `custom_components/mammotion/lawn_mower.py`, analyzed 2026-07-14.
This doc builds on protocol facts the maintainer already confirmed by direct source research —
it verifies them against source and turns them into an implementable plan; it does not re-derive
them from scratch.

## Why this exists

Our "Start Mowing" (Flow action `start_mowing`, and the `onoff` capability via
`actionStartMowing`) sends a bare `NavTaskCtrl{type:1, action:1}` task-control "start"
(`buildStartMowCommand` → `buildTaskControlCommand('start', …)` in
`lib/mammotion/commands/LubaCommands.ts`). That signal carries **no zone/area information** — it
only resumes whatever job the mower's own firmware still has cached.

Real diagnostic report (2026-07-14, Homey Pro 2026, device
`e00b8e76-4369-421f-98fd-78982a50e577`): the mower reported a job "finished" after 7 seconds
having covered 0 m² and returned to dock, because the cached job it resumed was a zone that was
already fully mowed. The reference app never starts a fresh job this way: it always runs a
**plan-route** step first that explicitly carries the zone hash(es) to mow, defaulting to **all
known zones** when the user picks none.

This doc scopes two combined features:
1. Fix "Start Mowing" to plan/select zones before starting, defaulting to "mow all known zones".
2. Add a Flow action card "Start mowing zone [[zone]]" with a live autocomplete zone dropdown.

## What was found (reference source, verified)

### The reference start-mowing decision tree (`lawn_mower.py::async_start_mowing`)

Verified by reading the actual method. Keyed on `sys_status` (`WorkMode`) and
`work.bp_info` (breakpoint info — a saved resume point):

- `MODE_RETURNING` → `cancel_return_to_dock`, then re-read mode.
- `MODE_PAUSE` **with** a breakpoint → `resume_execute_task` + `query_generate_route_information`
  (resume an interrupted job — no new zones).
- `MODE_READY`/`MODE_INITIALIZATION` **with** a breakpoint → `query_generate_route_information`
  then `start_job` (resume).
- `MODE_READY`/`MODE_INITIALIZATION` **without** a breakpoint (the fresh-start case) →
  **`async_plan_route(operation_settings)` then `start_job`**. This is the path our bug report
  hit and the path this plan implements.

Key detail: `start_job` is `NavTaskCtrl{type:1, action:1}` — **byte-for-byte identical to what we
already send today**. The missing piece is the `plan_route` that must precede it, not the start
signal itself.

### `async_plan_route` and the "default to all zones" rule (`mower_api.py`)

```
if not operation_settings.areas:
    operation_settings.areas = list(dict.fromkeys(device.map.area.keys()))
route_information = self.generate_route_information(device_name, operation_settings)
await self._mammotion.start_mow_path_saga(device_name, zone_hashs=..., route_info=route_information)
```

`device.map.area` is the map of `hash → name` populated by the area-name enumeration response
(below). So "mow all known zones" = "every hash we've enumerated".

### The wire command: `generate_route_information` → `NavReqCoverPath`

`navigation.py::generate_route_information` builds `MctlNav.bidire_reqconver_path = NavReqCoverPath`
with `sub_cmd=0` and these fields (from `GenerateRouteInformation` + `OperationSettings` defaults):

| NavReqCoverPath field | Value / default source |
|---|---|
| `pver` | 1 |
| `sub_cmd` | 0 (generate; 3 = modify, 9 = end, 2 = query) |
| `zone_hashs` | `list(one_hashs)` = the area hashes to mow (fixed64, repeated) |
| `job_mode` | 4 (taskMode) |
| `edge_mode` | `mowing_laps` (default 1) |
| `knife_height` | `blade_height` (default 0; Yuka forces -10 — not our target) |
| `speed` | 0.3 |
| `ultra_wave` | 2 |
| `channel_width` | 25 |
| `channel_mode` | 0 |
| `toward` / `toward_mode` / `toward_included_angle` | 0 / 0 / 0 |
| `reserved` | `create_path_order(...)` — an 8-byte string (see below) |

`reserved`/path_order is an 8-byte buffer decoded as a UTF-8/latin-1 string
(`create_path_order` in `data/model/device_config.py`). For a full-size Luba (non-Yuka,
non-Luba1) with defaults: `[0]=border_mode(0)`, `[1]=obstacle_laps(1)`, `[2]=0`, `[3]=0`,
`[4]=0`, `[5]=8 if is_luba_pro else 0`, `[6]=collect_grass_frequency(10) if is_dump else 10`,
`[7]=0`. So for our Luba 2/3 (luba_pro) targets the default reserved bytes are
`[0,1,0,0,0,8,10,0]`. **This encoding is load-bearing** — a wrong `reserved` risks the device
computing a wrong or empty route.

### The zone enumeration exchange (already-confirmed protocol, re-verified)

Request — `navigation.py::get_area_name_list(device_id)`:
`MctlNav.toapp_map_name_msg = NavMapNameMsg{hash:0, result:0, device_id:<iot_id>, rw:0}`.
Note `device_id` is the **iotId** (`context.iotId`), not `deviceName`.

Response — `MctlNav.toapp_all_hash_name = AppGetAllAreaHashName{deviceId, hashnames: repeated
area_hash_name}` where `area_hash_name = {hash: fixed64, name: string}`.

### Does starting a job need the FULL MowPathSaga? — NO (verified)

`async_plan_route` enqueues `MowPathSaga`, whose 4 steps are (from its docstring, read directly):
1. `get_all_boundary_hash_list(sub_cmd=3)` + collect/ack line-hash frames,
2. `generate_route_information` (sub_cmd=0) + wait for the device's confirmation,
3. `get_line_info_list` (per-hash),
4. collect `cover_path_upload` frames.

Steps 1, 3, 4 exist **only to download the computed path polygons into
`device.map.current_mow_path` / `generated_mow_path_geojson` for Home Assistant's live map
card**. The device computes and stores the route internally the moment it receives
`generate_route_information` (step 2); `start_job` then mows that stored route. **Our app has no
map UI, so we need step 2 and `start_job` only.** This is verified reasoning from the saga's own
purpose (cover-path collection), not an assumption that "less is fine" — the cover path is
display data, not a device-state prerequisite for mowing.

Minimal defensible sequence for a fresh start:
1. (ensure the report/sync is fresh — we already re-arm telemetry; BLE also needs
   `todev_ble_sync`, which `BleTransport` issues on connect — see risks)
2. send `generate_route_information` (`bidire_reqconver_path`, sub_cmd=0, `zone_hashs=[…]`)
3. wait for the device's `bidire_reqconver_path` echo (route accepted) OR a short timeout
4. send `start_job` = `NavTaskCtrl{type:1, action:1}` (our existing start command)

## Descriptor coverage — NO regeneration needed (verified)

Extracted every field of the relevant messages from
`lib/mammotion/protocol/generated/descriptor.ts` and compared to `pymammotion/proto/__init__.py`:

- `NavReqCoverPath`: descriptor has `pver, jobId, jobVer, jobMode, subCmd, edgeMode, knifeHeight,
  channelWidth, UltraWave, channelMode, toward, speed, zoneHashs, pathHash, reserved, result,
  towardMode, towardIncludedAngle` — **complete match** with pymammotion's 18 fields. `zoneHashs`
  is fixed64 repeated; `reserved` is string. Every field the generate command sets is present.
- `MctlNav` carries `bidireReqconverPath`, `toappAllHashName`, `toappMapNameMsg`,
  `zoneStartPrecent` (the `zone_start_precent_t` reply `start_job` waits on), `todevTaskctrl`.
- `NavMapNameMsg`: `rw, hash, name, result, deviceId` — complete.
- `AppGetAllAreaHashName`: `deviceId, hashnames`; `area_hash_name`: `hash, name` — complete.
- `NavTaskCtrl`: `type, action, result, reserved` — complete.

**Conclusion: zero `.proto`/descriptor changes required for either feature.** No regeneration
blocker.

## Design decisions (resolving the maintainer's questions)

### 1. Where zone enumeration is triggered/cached

Mirror the existing on-demand `requestSchedule()` pattern (`device.ts:359`): a fire-and-send
request whose response lands asynchronously in `handleRawMessage` (`device.ts:310`). Concretely:

- **New builder** `buildGetAreaNameListCommand(userAccount, iotId, seq, productKey)` in
  `LubaCommands.ts` → `MctlNav.toappMapNameMsg = {rw:0, hash:0, result:0, deviceId:iotId}`
  routed via `isLubaProDevice` receiver, exactly like `buildReadScheduleCommand`.
- **New parser** `extractAreaHashNames(msg)` in a small `AreaNameParser.ts` (mirror
  `ScheduleParser.ts`): reads `msg.nav.toappAllHashName.hashnames[]` → `{hash: string, name}`.
  Hashes are fixed64 → keep as **string** end-to-end (JS number loses precision above 2^53; the
  wire type is 64-bit). The command builder must accept string/bigint hashes and encode as
  fixed64.
- **Cache** the last-known list on the device instance (in-memory field, optionally mirrored via
  `setStoreValue('zones', …)` so it survives restarts for a warm first dropdown). Refresh:
  (a) once on `onInit` (so the first dropdown open has data), and (b) on each autocomplete
  callback (fire a refresh, return the cached list immediately — the response updates the cache
  for next open). This matches "pull, not push" since zones change only via the official app.

### 2. How `areas`/zone selection extends `StartMowOptions`

Extend the interface (currently `bladeHeight`/`speed`/`isEdge`, barely used) with
`areas?: string[]` (fixed64 hashes as strings). Orchestration in `actionStartMowing`:

- Resolve `areas`: if provided, use them; if empty/omitted, default to **all cached zone
  hashes**.
- Build + send `generate_route_information` (new `buildGenerateRouteCommand(options, areas, …)`),
  await the `bidireReqconverPath` echo (add a handler branch in `handleRawMessage`) or a ~3 s
  timeout, then send the existing `start` task-control (`buildTaskControlCommand('start', …)`).
- Keep `buildStartMowCommand` as-is for the resume path; the new flow is a distinct method so we
  don't regress "resume a paused job".

Do **not** attempt the full breakpoint/resume decision tree from `async_start_mowing` in v1 (mode
+ `bp_info` gating). We already send a bare start that resumes fine when a job is genuinely
paused; the bug is specifically the **fresh start with no meaningful cached job**. Scope v1 to:
"if the user invokes start/zone-start, plan the requested (or all) zones then start." Note the
fuller mode-aware tree (resume vs re-plan) as a follow-up — it needs `sys_status`/`bp_info`
telemetry wiring we can add later.

### 3. Separate card vs. new argument

**Add a separate `start_mowing_zone` action card** with a `zone` autocomplete argument (Homey SDK
3 `type: "autocomplete"`, wired via `getArgumentAutocompleteListener('zone', …)` in
`driver.ts::registerFlowCards`). Rationale:
- The existing `start_mowing` card takes `blade_height`/`speed`/`edge_mowing` and is used in
  live user flows — adding a required-looking zone arg changes its shape and risks confusing the
  installed base.
- The maintainer explicitly phrased it as "Start mowing zone [[zone]]".
- The existing `start_mowing` card (and `onoff`) get the **"mow all known zones" default** for
  free (feature 1) with no new argument.

v1 autocomplete is single-zone (one dropdown → `areas:[hash]`). Multi-zone selection (Homey has
no native multi-select arg) is a deferred follow-up (could be N cards chained, or a comma text
arg — out of scope).

### 4. Zero-zones edge case

If the cached zone list is empty when a start is requested (fresh pairing, enumeration not yet
returned, or a device with genuinely no saved zones):

- **Fail closed with a clear, localized error** ("No mowing zones known yet — open the mower in
  the Mammotion app / wait a moment and retry"), rather than falling back to the bare-start
  signal. Bare start is exactly the behavior that produced the bug; silently doing it again would
  re-hide the failure.
- Before failing, do one **synchronous best-effort enumeration** (send the request, wait briefly
  for the response to populate the cache) so a just-paired device that simply hasn't enumerated
  yet still works on first try. Only fail if that yields nothing.
- The specific-zone card (`start_mowing_zone`) can't reach this state — its autocomplete only
  offers hashes that exist — but it must still handle "cache emptied since dropdown opened"
  gracefully (same error).

### 5. Transport parity (BLE / MQTT / aliyun_legacy)

`sendRaw` (`device.ts:826`) routes to BLE, `aliyun_legacy` (REST invoke), or MQTT — all three
carry **raw protobuf bytes**. `generate_route_information` and `start_job` are just two more raw
sends, so all three transports support the multi-step flow equally at the send layer. Nuances to
handle, not blockers:
- **Confirmation wait**: the `bidireReqconverPath` echo arrives through the unified
  `handleRawMessage` regardless of transport, so the "wait for route-accepted" branch works for
  all three. If a given transport proves not to echo, fall back to a fixed short delay before
  `start_job` (degrade, don't fail).
- **BLE sync freshness**: the reference saga re-issues `todev_ble_sync` before major requests
  because the device's "synced" state lapses. `BleTransport` syncs on connect; for BLE we should
  issue a `buildBleSyncCommand` immediately before `generate_route_information` to match. MQTT/
  aliyun use `sync_type=3` semantics handled by the existing telemetry re-arm.
- **aliyun_legacy**: send path is proven for single commands (v2.4.0) but the two-step
  plan+start has **never been exercised live** on that transport — same caveat as the rest of
  that subsystem.

## What is explicitly NOT being built

- **No cover-path / map polygon fetch** (MowPathSaga steps 1/3/4). No map UI to consume it;
  it's display-only data. This is the deliberate "don't port the whole saga" call, justified from
  source above.
- **No full mode-aware resume/re-plan decision tree** (`sys_status` + `bp_info` gating from
  `async_start_mowing`). v1 plans-then-starts; smarter resume-vs-replan is a flagged follow-up.
- **No multi-zone selection UI** in v1 (Homey lacks a native multi-select arg). Single zone +
  "all zones" default only.
- **No zone rename/create/delete** (`set_area_name`, `rw:1`). Read/enumerate only, matching the
  read-only stance we took for scheduling.
- **No per-model route-param limits** (blade-height/speed/path-spacing ranges from
  `device_config.py`) — carried over as the same follow-up already noted in the capability doc.
- **No Yuka handling** (`blade_height=-10`, `calculate_yuka_mode`) beyond leaving the code
  structured for it — roadmap defers Yuka.

## Verification — what can and cannot be checked before shipping

- **Verifiable now:** round-trip encode/decode of `NavReqCoverPath` (with string fixed64
  `zoneHashs` + 8-byte `reserved`) and of the `NavMapNameMsg`/`AppGetAllAreaHashName` exchange
  against our own descriptor (a `scripts/*.test.mjs`, same as `test:schedule`). `create_path_order`
  byte-layout parity against pymammotion. `extractAreaHashNames` against a captured/synthetic
  response frame.
- **NOT verifiable without live hardware/account:** that `generate_route_information` +
  `start_job` actually starts a fresh mow of the intended zones on a real Luba 2/3, that the
  device echoes `bidireReqconverPath` as a usable confirmation, and that skipping the cover-path
  saga has no side effect on job start. This is the same class of risk as the Aliyun legacy
  subsystem — **state it plainly to the user**. The reporting user (device
  `e00b8e76-…`, Homey Pro 2026) is the natural live-test partner and the exact person the fix is
  for; a single "mow all zones" start on their unit is the go/no-go test.
- **NOT verifiable:** aliyun_legacy two-step behavior (no live account for that path).

## Recommended scope & phasing

**Ship in two phases; Phase 1 does all the heavy plumbing and directly fixes the bug.**

**Phase 1 — enumeration + generate-route + "mow all zones" default (the bug fix).**
Build: `buildGetAreaNameListCommand`, `AreaNameParser.extractAreaHashNames`, zone cache +
`onInit`/autocomplete refresh, `buildGenerateRouteCommand`, `create_path_order` port,
`bidireReqconverPath` confirmation handling, and a new `actionPlanAndStartMowing` orchestrating
generate→start. Wire the existing `start_mowing` card + `onoff` to default to all cached zones.
Fail-closed on zero zones. This is the entire reverse-engineered surface and the whole fix.

**Phase 2 — `start_mowing_zone` autocomplete card (thin add).**
Just a new compose card + `getArgumentAutocompleteListener('zone', …)` returning the cached list
+ a run listener calling `actionPlanAndStartMowing({areas:[hash]})`. Reuses 100% of Phase 1
plumbing; near-zero incremental protocol risk (it's UI over an already-built path).

**Why phase, not ship-both-at-once:** the risky, unverifiable-without-hardware part
(`generate_route_information` actually starting a real job) lives entirely in Phase 1. Land
Phase 1, get one live confirmation from the reporting user, *then* ship Phase 2 immediately after
(or in the same release if live confirmation comes fast). Phasing keeps the go/no-go decision
attached to the smallest possible change and doesn't gate the bug fix on the extra UI. If live
verification is quick, they can ship together — but the plumbing must be built and proven
before the picker card is meaningful, so Phase 1 is the hard dependency either way.

## Next steps

1. Slot in `docs/ROADMAP.md` — this is a correctness fix for a shipped bug with a live reporter;
   place above P1 widgets, alongside the other reverse-engineered command fixes.
2. Developer agent: implement Phase 1 (builders + parser + cache + orchestration + tests),
   version bump + changelog. Keep `buildStartMowCommand`/resume path intact.
3. Live test with the reporting user: a single "mow all zones" start on device `e00b8e76-…`.
   Watch the diagnostic for a non-zero mowed area / correct zone.
4. On confirmation, implement Phase 2 (the `start_mowing_zone` card + autocomplete) and i18n for
   all 13 languages (new card title/hint + the zero-zones error string).
5. Follow-ups to file: mode-aware resume/re-plan tree; multi-zone selection; per-model route
   limits.
