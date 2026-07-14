# Zone boundary fallback — enumerating UNNAMED zones so "Start Mowing" works — analysis & scope

Source of truth: `mikey0000/pymammotion` (local clone at `/tmp/pymammotion`, read directly — not
re-cloned) and our own shipped code (`drivers/luba/device.ts`,
`lib/mammotion/commands/LubaCommands.ts`, `lib/mammotion/protocol/AreaNameParser.ts`,
`lib/mammotion/protocol/generated/descriptor.ts`), analyzed 2026-07-14.

This is **Phase 3** of the zone-selection feature. Phases 1 (v2.5.48) and 2 (v2.5.49) are shipped
and described in `docs/ZONE_SELECTION_PLAN.md` — read that first. This doc scopes only the
newly-confirmed gap and does not re-derive facts already established there.

## Why this exists

Phases 1–2 source zone hashes **exclusively** from `get_area_name_list`
(`MctlNav.toapp_map_name_msg` request → `MctlNav.toapp_all_hash_name` response,
`AppGetAllAreaHashName.hashnames: repeated area_hash_name{hash, name}`), cached in
`device.ts`'s `zoneCache`. When that list is empty, `actionPlanAndStartMowing`
(`drivers/luba/device.ts:981`) throws `NoZonesKnownError` (`lib/mammotion/errors.ts:114`) — a
deliberate fail-closed choice so we never silently re-send the bare start that produced the
original bug.

### The confirmed bug (real user)

Diagnostic report — device `Luba-VAZSPPU6`, log `e038ef7c-7d06-423a-b73d-ebc7f9cefdbf`:
`get_area_name_list` returned `hashnames: []` (empty) **twice** in one session, while a separate
`MctlNav.toapp_get_commondata_ack` (`NavGetCommDataAck`) frame in the same log showed the device
**does** hold real boundary data (a 5-point rectangle, `dataHash:"146"`). The user then confirmed:
"that start mowing from home failed."

**Root cause, now verified against source:** `get_area_name_list` only returns areas the user has
explicitly **named** in the official Mammotion app's naming screen. A device with an unnamed
default boundary — the likely common case for a single-yard user who never opened that screen —
returns an empty named list even though a mowable boundary exists. Our fail-closed path then
correctly refuses to start, so Phase 1/2's fix does nothing for these users.

**Confirmation that "named list empty ≠ no zones" is the intended reading:** pymammotion's
`MapFetchSaga` fills in synthetic `f"area {i + 1}"` labels precisely when the named list came back
empty but area hashes were nonetheless fetched (`pymammotion/messaging/map_saga.py:322-333`). The
reference treats the named list as a *display-name overlay*, not the source of truth for which
zones exist.

## What was found (reference source, verified line-by-line)

### The named list is naming-only — the raw hash list is separate

- `get_area_name_list(device_id)` builds `MctlNav(toapp_map_name_msg=NavMapNameMsg(hash=0,
  result=0, device_id=<iot_id>, rw=0))` — `navigation.py:385`. This is what we already send. Reply
  = `toapp_all_hash_name`, naming overlay only. Verified: in `map_saga.py` step 1 (`:139-160`) the
  response is used *only* to populate `map.area_name`, and the fallback at `:322-333` proves an
  empty response does not imply an empty map.

### `get_all_boundary_hash_list(sub_cmd)` — the raw root hash list (the fallback source)

- `get_all_boundary_hash_list(sub_cmd)` builds `MctlNav(todev_gethash=NavGetHashList(pver=1,
  sub_cmd=sub_cmd))` — `navigation.py:412-415`. This is **different** from `get_area_name_list`:
  it returns the device's raw root hash manifest, unfiltered by naming.
- **`sub_cmd=0` is the one we want.** `MapFetchSaga` uses it for the ROOT hash list
  (`map_saga.py:180` region — `get_all_boundary_hash_list(sub_cmd=0)`), which contains **every**
  boundary/obstacle/path hash the device holds. Reply = `MctlNav.toapp_gethash_ack`
  (`NavGetHashListAck`).
- **`sub_cmd=3` is NOT zone discovery — do not use it.** `MowPathSaga` uses it
  (`mow_path_saga.py:122-125`) for the "line hash list" / breakpoint-line hashes of cover-path
  fetching. Confirmed from that file's own filter `lambda v: v.sub_cmd == 3` and its
  `requesting line hash list (sub_cmd=3)` log. `map_saga.py:167-171` explicitly warns that an
  interrupted `MowPathSaga` can leave the device retransmitting unacked `sub_cmd=3` frames, and it
  filters root-list collection to `v.sub_cmd == 0` to avoid mistaking one for the root list. We
  must apply the same `sub_cmd == 0` filter.

### `NavGetHashListAck` is multi-frame and ack-driven

`NavGetHashListAck` fields (confirmed present in our descriptor, see coverage section):
`pver, subCmd, totalFrame, currentFrame, dataHash, hashLen, reserved, result, dataCouple: repeated
int64`. The hashes are in `dataCouple`.

Frame loop (verified `map_saga.py:184-213`):
1. Send `get_all_boundary_hash_list(sub_cmd=0)` **once**.
2. For every incoming `toapp_gethash_ack` frame, send `get_hash_response(total_frame,
   current_frame)` = `MctlNav(todev_gethash=NavGetHashList(pver=1, sub_cmd=2,
   current_frame=..., total_frame=...))` (`navigation.py:418-424`). This ack tells the device
   "send me the next frame."
3. Stop when `current_frame >= total_frame`.

**Load-bearing invariant** (`map_saga.py:187-191, :207` comments): `get_hash_response` is *never*
sent proactively — only in response to a received frame. Sending it early desyncs the loop.

### The root list does NOT classify hashes — per-hash type probe required

The root list is a flat `int64` hash list mixing areas, obstacles, paths, no-go zones, etc. It
carries **no per-hash type**. Classification happens per hash via a second exchange:

- `synchronize_hash_data(hash_num)` builds `MctlNav(todev_get_commondata=NavGetCommData(pver=1,
  action=8, hash=hash_num, sub_cmd=1))` — `navigation.py:428-431`.
- Reply = `MctlNav.toapp_get_commondata_ack` (`NavGetCommDataAck`) whose `.type` field is a
  `PathType`. The device dispatches by `hash_data.type == PathType.AREA` to store it as a mowable
  area (`hash_list.py:827-828` `update()`), and `PathType.AREA = 0` (`hash_list.py:27`). Other
  values: `OBSTACLE=1, PATH=2, TRANSFER_ZONE=3, …, NO_GO_ZONE=23` (`hash_list.py:21-88`).
- **Only `type == 0` (AREA) hashes are mowable zones.** Feeding a `type != 0` hash into
  `NavReqCoverPath.zone_hashs` is the exact correctness risk to avoid.

`NavGetCommDataAck` is itself multi-frame (`totalFrame`/`currentFrame`, `dataCouple:
repeated CommDataCouple{x,y}` = the polygon points). Crucially, **`.type` is present on the very
first frame** — we do not need the polygon points at all (we are classifying, not mapping). The
device streams and re-transmits frames until acked, though (`map_saga.py:245-258` — unacked frames
flood with an incrementing `dataHash`), so a probe still has to drain/ack each hash's stream
politely before moving on. Per-frame acks in the reference use `get_regional_data(...)`
(`navigation.py:463` region) and **`synchronize_hash_data` must not be re-sent for the hash already
streaming** or the device restarts it from frame 1 (`map_saga.py:311-317`).

### The full correct flow (for reference — this is MapFetchSaga steps 1–4)

1. `get_area_name_list` → names overlay (we already do this).
2. `get_all_boundary_hash_list(sub_cmd=0)` + ack loop → the root hash list.
3. For each hash: `synchronize_hash_data(hash)`, read the ack's `.type`, drain/ack its frames.
4. Keep only `type == AREA` hashes; fill `f"area {i+1}"` names for any without a named-list entry.

Phase 1 deliberately did **not** build steps 2–4 (`docs/ZONE_SELECTION_PLAN.md` §"Does starting a
job need the FULL MowPathSaga? — NO"). This plan reintroduces a **trimmed** steps 2–3 plus a
**type-only** slice of step 4 — and nothing more (no polygon/SVG collection, no map storage).

## Descriptor coverage — NO regeneration needed (verified)

Extracted from `lib/mammotion/protocol/generated/descriptor.ts` and compared to pymammotion's
`proto/__init__.py`. All four messages and the `MctlNav` oneof slots are present:

| Message (`MctlNav` field, id) | Fields in our descriptor |
|---|---|
| `NavGetHashList` (`todevGethash`, 30) | `pver, subCmd, totalFrame, currentFrame, dataHash(fixed64), reserved` — every field the request/ack builders set (`sub_cmd`, `current_frame`, `total_frame`) present |
| `NavGetHashListAck` (`toappGethashAck`, 31) | `pver, subCmd, totalFrame, currentFrame, dataHash, hashLen, reserved, result, dataCouple(repeated int64)` — complete |
| `NavGetCommData` (`todevGetCommondata`, 32) | `pver, subCmd, action, type, hash(int64), paternalHashA/B, totalFrame, currentFrame, dataHash, reserved` — `synchronize_hash_data`'s `action=8, hash, sub_cmd=1` all present |
| `NavGetCommDataAck` (`toappGetCommondataAck`, 33) | `pver, subCmd, result, action, type, Hash(fixed64), paternalHashA/B(fixed64), totalFrame, currentFrame, dataHash, dataLen, dataCouple(CommDataCouple), reserved, nameTime` — `.type` and `.Hash` (the fields we read) present |

**Two field-name gotchas** to carry into the builders/parsers (verified above):
- The request field is lowercase `hash` (`int64`); the **ack** field is capitalized **`Hash`**
  (`fixed64`). A parser reading the response type must read `Hash`, not `hash`.
- The same numeric hash is `fixed64` in `area_hash_name`/`NavGetCommDataAck.Hash` but `int64` in
  `NavGetHashListAck.dataCouple` and the `NavGetCommData.hash` request. pymammotion treats them all
  as the same `int` — so the **decimal string** is identical across encodings; the string-hash
  discipline from `AreaNameParser.ts` (keep fixed64 as strings, never JS numbers) applies to
  `dataCouple` too, and the encoder emits the right wire type per field.

**Conclusion: zero `.proto`/descriptor changes required.** Same result as Phases 1–2.

## Design decisions (resolving the maintainer's six questions)

### 1. Full classification round-trip vs. cheaper heuristic

Three options, ranked:

**Option A (recommended) — root list + bounded per-hash type probe, keep AREA, fail-closed.**
Send the root-list request + ack loop (steps 2–3), then for each root hash send
`synchronize_hash_data`, read `.type` from the first ack, drain/ack that hash's frames, keep only
`type == 0`. Bound it hard: a per-frame timeout (~5 s, matching the reference `step_timeout`), a
per-hash timeout, a total-hash cap (e.g. 32), and an overall wall-clock budget. If discovery can't
complete, keep any AREA hashes already found; if none were found, **fail closed with
`NoZonesKnownError`** exactly as today. This never feeds an obstacle/path/no-go hash into
`zone_hashs`, so correctness is preserved even on a partial run.

**Option B — lite type-probe, no full drain.** Same, but read only the first ack per hash then
immediately send the next `synchronize_hash_data` without draining. Fewer round trips, but the
device's behavior when a hash's stream is abandoned mid-flight is **unverified** and
`map_saga.py:250-258` warns unacked frames flood with incrementing `dataHash` — over a small-MTU
BLE link that noise competes with the very frames we need. Medium risk, low confidence. Not
recommended as the default; acceptable as a later optimization if Option A proves too slow and the
abandon-stream behavior gets confirmed live.

**Option C — no classification, feed every root hash as a zone.** Cheapest (root list + ack loop
only). Rejected: sending a `type != 0` hash in `zone_hashs` risks the device computing a wrong or
empty route — reintroducing a variant of the original bug on an unverifiable code path. This is the
correctness regression the maintainer flagged; do not ship it.

**Why A over C despite BLE fragility:** the whole failure mode we are fixing is "the device silently
does the wrong thing." Guessing that all root hashes are mowable is another silent-wrong-thing bet.
A bounded, fail-closed classifier is strictly honest: it either produces verified-AREA hashes or
refuses, never a wrong route.

### 2. New command builders + parsers

New builders in `lib/mammotion/commands/LubaCommands.ts` (mirroring
`buildGetAreaNameListCommand`/`buildReadScheduleCommand` — same `isLubaProDevice` receiver routing,
same `envelope(MsgCmdType.NAV, receiver, userAccount, seq)` shape):

- `buildGetBoundaryHashListCommand(userAccount, deviceName, seq, productKey)` →
  `nav.todevGethash = { pver: 1, subCmd: 0 }`.
- `buildGetHashResponseCommand(totalFrame, currentFrame, userAccount, deviceName, seq, productKey)`
  → `nav.todevGethash = { pver: 1, subCmd: 2, currentFrame, totalFrame }`.
- `buildSynchronizeHashDataCommand(hash, userAccount, deviceName, seq, productKey)` →
  `nav.todevGetCommondata = { pver: 1, action: 8, hash, subCmd: 1 }` (`hash` a decimal string).
- Frame ack for `NavGetCommDataAck` (Option A's drain): the reference uses `get_regional_data`
  (`NavGetCommData` with `action/type/hash/totalFrame/currentFrame/dataHash` echoed from the frame).
  A `buildRegionalDataAckCommand(ackFrame, …)` echoing those fields is needed only if we drain
  frames. If a leaner drain proves unnecessary live, this builder can be dropped.

New parsers (mirror `AreaNameParser.ts`, return `null` when the message isn't the expected type):
- `extractRootHashList(msg)` → from `nav.toappGethashAck`, filtered to `subCmd === 0`:
  `{ subCmd, totalFrame, currentFrame, dataCouple: string[] }` (hashes as **strings**).
- `extractCommDataAck(msg)` → from `nav.toappGetCommondataAck`:
  `{ hash: String(msg…​.Hash), type: number, totalFrame, currentFrame }` (read capital `Hash`).

**Descriptor coverage for all of the above is already complete** (table above) — same verification
rigor as `docs/ZONE_SELECTION_PLAN.md`'s coverage section; no regeneration.

### 3. Where/whether to gate the fallback

Gate it tightly — the common case (naming already works) must pay **zero** extra round trips.

Extend `actionPlanAndStartMowing` (`device.ts:981`). Current flow: empty `areas` → use
`zoneCache` → if still empty, one best-effort `requestAreaNameList()` + `waitForZoneCache(3000)` →
if still empty, `NoZonesKnownError`. Insert the fallback **between** that last named-list attempt
and the throw:

1. Named list (existing) → if it yields hashes, done. No change, no extra cost.
2. Only if the named list is genuinely empty **and** the warm cache holds no previously-discovered
   zones (see below): run `requestBoundaryZoneDiscovery()` (Option A), populate `zoneCache` with
   the discovered AREA hashes + synthetic names, persist to the store.
3. Only if that also yields nothing → `NoZonesKnownError` (unchanged contract).

**Warm-cache once-ever rule (key mitigation for BLE fragility):** the fragile multi-round-trip
sequence should need to succeed only *once* per device, ever. `handleAreaHashNamesResponse`
(`device.ts:350`) already mirrors `zoneCache` to `setStoreValue('zones', …)`. Persist
discovered synthetic-name zones the same way and treat a non-empty stored cache as "discovery
already done" so step 2 never re-runs on a device that has enumerated once. A user who succeeds in a
single lucky BLE window (or via cloud) is set for all subsequent starts.

### 4. Surfacing unnamed zones in the "Start mowing zone…" autocomplete (Phase 2 card)

Synthetic names `Area 1 … Area N`, matching pymammotion's `f"area {i + 1}"`
(`map_saga.py:326`, sorted by hash for stable ordering). The Phase 2 autocomplete
(`drivers/luba/driver.ts:122-126`) maps `name || hash` and needs **no change** — a discovered zone
is just `{ hash, name: "Area 1" }` in `zoneCache`.

One honest nuance: `getZoneList()` (`device.ts:450`) triggers `requestAreaNameList()` (named only),
so for a never-enumerated unnamed device the dropdown is empty until discovery has run once.
**Do not** run the heavy Option-A discovery from the autocomplete callback — it's far too slow/
fragile for an interactive dropdown. Instead, discovered zones surface from the persisted warm
cache: the first "Start Mowing (all zones)" invocation runs discovery and caches the synthetic
zones; from then on the specific-zone dropdown shows `Area N`. Optionally kick discovery once on
`onInit` for unnamed devices so the first dropdown open is warm — acceptable since it's
one-per-boot and store-cached, but it inherits all the BLE-fragility caveats and must never block
init.

### 5. Interaction with `NoZonesKnownError` and the timeout/waiter budgets

- **Fail-closed contract unchanged.** The fallback only widens what counts as "zones exist"; it
  never falls back to a bare start. If discovery finds no AREA hash, `NoZonesKnownError` still fires.
- **New budgets are needed** — this adds many round trips vs. the current single 3 s
  `waitForZoneCache`. Introduce a dedicated discovery budget rather than reusing the 3 s wait:
  ~5 s per frame (reference `step_timeout`), a per-hash timeout, a hash-count cap (~32), and an
  overall cap (~20–30 s). Reuse the existing `zoneCacheWaiters`/`waitForZoneCache` pattern
  (`device.ts:370-378`) for the individual frame waits (add a `rootHashWaiters` /
  `commDataWaiters` pair in the same style, resolved from `handleRawMessage`), and degrade to the
  timeout rather than hanging.
- **UX caveat:** a 20–30 s synchronous wait inside a Flow "start" action is perceptibly long. The
  warm-cache-once rule confines this cost to the first ever start on an unnamed device; call it out
  in the changelog. If it proves too long live, Option B or a background pre-warm is the follow-up.

### 6. BLE vs MQTT — materially different failure mode (yes)

This is the sharpest risk, and it hits the exact reporting user hardest.

- **BLE.** The sequence is multi-round-trip, ack-driven, and stateful: the device only serves
  hash-list and comm-data frames while it considers the app "synced," and that state lapses after a
  few seconds — the reference re-issues `todev_ble_sync` **before the root-list request and before
  the per-hash step** and heartbeats it ~every 1.5 s (`map_saga.py:98-124, :168, :244-248`). This
  user's log is full of GATT-setup timeouts and reconnect cycling, so a long ack-driven loop is
  *far* more likely to stall mid-sequence than the single-shot named-list request that already
  fails for them. Mitigation: interleave `buildBleSyncCommand` (`LubaCommands.ts:283`) before the
  root-list request and before the per-hash loop, exactly as the reference does; keep per-step
  timeouts short; rely on the warm-cache-once rule so a single successful window suffices.
- **MQTT / cloud.** The broker buffers and round trips are reliable; the multi-step sequence is
  much more likely to complete in one go. For users with a cloud account this is the strongly
  preferred transport for discovery, and worth noting to the reporting user.
- **aliyun_legacy.** Same standing caveat as the rest of that subsystem — the multi-step,
  ack-driven pattern has **never been exercised live** on that transport. Do not claim it works
  there; attempt-and-degrade.

## What is explicitly NOT being built

- **No polygon / map storage.** We read `NavGetCommDataAck.type` and discard `dataCouple` (the x/y
  points). This is classification, not a map port — no `HashList`, no `device.map`, no geojson.
- **No SVG tile handling** (`toapp_svg_msg`, `PathType.SVG`) — display-only, no consumer.
- **No obstacle / path / no-go / virtual-wall handling** beyond *excluding* them from `zone_hashs`.
- **No `sub_cmd=3` line-hash / cover-path fetch** — that's `MowPathSaga`, unrelated to zone
  discovery and still deliberately not ported (`docs/ZONE_SELECTION_PLAN.md`).
- **No zone rename/create/delete** (`set_area_name`, `rw:1`) — read/enumerate only, unchanged.
- **No multi-zone selection UI, no Yuka, no per-model route limits** — same deferrals as Phases 1–2.
- **No Option B/C behavior** — no un-classified hashes ever reach `zone_hashs`.

## Verification — what can and cannot be checked before shipping

- **Verifiable now (unit tests, `scripts/*.test.mjs`, same as `test:schedule`):** round-trip
  encode/decode of `buildGetBoundaryHashListCommand`, `buildGetHashResponseCommand`,
  `buildSynchronizeHashDataCommand` against our descriptor; `extractRootHashList` (string
  `dataCouple`, `subCmd==0` filter) and `extractCommDataAck` (capital `Hash`, `type`) against
  synthetic frames; the ack-loop termination logic (`current_frame >= total_frame`) and the
  `type==0` filter against synthetic multi-frame fixtures; synthetic `Area N` naming/sort parity
  with `map_saga.py:326`.
- **NOT verifiable without live hardware/account:** that `get_all_boundary_hash_list(sub_cmd=0)`
  actually returns a root list on a real *unnamed-zone* device; that the first `NavGetCommDataAck`
  frame reliably carries a usable `.type`; that the drain/ack loop terminates cleanly over a flaky
  BLE link; and — the crux — that `generate_route_information` with a **discovered, never-named**
  AREA hash actually starts a real mow. This is the same class of risk as the Aliyun legacy
  subsystem — state it plainly. The reporting user (device `Luba-VAZSPPU6`, log
  `e038ef7c-…`) is the natural and exact-fit live-test partner; a single "mow all zones" start on
  their unit is the go/no-go test.
- **NOT verifiable:** aliyun_legacy multi-step behavior (no live account for that path).

## Recommended scope & sequence

Ship as one focused change (the plumbing is one cohesive fallback; there's no meaningful sub-phase
to split as there was in Phase 1 vs 2):

1. Builders (`buildGetBoundaryHashListCommand`, `buildGetHashResponseCommand`,
   `buildSynchronizeHashDataCommand`, + frame-ack builder if draining) and parsers
   (`extractRootHashList`, `extractCommDataAck`) with unit tests.
2. `requestBoundaryZoneDiscovery()` on `LubaDevice`: root-list ack loop → per-hash type probe →
   keep `type==0` → synthesize `Area N` names → persist to the warm store cache. Interleave
   `buildBleSyncCommand` before the root-list request and the per-hash loop. Hard budgets + fail
   safe.
3. Gate it in `actionPlanAndStartMowing` between the named-list attempt and the `NoZonesKnownError`
   throw, guarded by the warm-cache-once rule so the common (naming-works) path pays nothing.
4. i18n: no new user-facing strings strictly required (reuses `error.no_zones_known`); if a
   changelog/UX note about the one-time discovery delay is wanted, add it, and audit all 13
   languages per the maintenance note in `docs/ROADMAP.md`.
5. Live test with the reporting user; watch the diagnostic for a non-zero mowed area.
6. Follow-ups to file: Option B optimization (if Option A is too slow, once abandon-stream behavior
   is confirmed live); `onInit` pre-warm discovery for unnamed devices; the still-deferred
   mode-aware resume/re-plan tree and multi-zone selection from Phases 1–2.

## Next steps

1. Slot into `docs/ROADMAP.md` alongside the Phase 1/2 zone-selection fixes — a correctness fix for
   a shipped bug with a live reporter; place above P1 widgets, same as the other reverse-engineered
   command fixes.
2. Developer agent: implement per "Recommended scope & sequence" above. Keep the Phase 1/2
   named-list path and the fail-closed contract intact; the fallback only widens what counts as
   "zones exist."
3. Live-verify on device `Luba-VAZSPPU6` before treating the unnamed-zone case as fixed — this is
   unverifiable without that hardware, exactly like the Aliyun legacy subsystem.
</content>
</invoke>
