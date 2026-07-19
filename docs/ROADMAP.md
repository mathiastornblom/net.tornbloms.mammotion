# Roadmap & prioritized backlog

Last reviewed: 2026-07-15, app version v2.5.54 (`test`; `main` mirrors the last Homey-approved
build, v2.5.53). This is the single source of truth for "what's next" — check here before
starting new work. Update this file (not just memory) whenever priority shifts, since it's
versioned with the code and visible to anyone reading the repo.

## P0 — Active / blocking

- **GitHub Pages homepage (`gh-pages` branch) has disappeared from the remote.** Discovered
  2026-07-15 via `git fetch --prune` reporting `origin/gh-pages` as deleted; confirmed via
  `list_branches` that only `main`, `test`, and the current feature branch exist — not a local
  caching artifact. No workflow in `.github/workflows/` builds or publishes this branch, so it
  won't regenerate on its own. Nobody on this session deleted it. Live-site status is
  unconfirmed (a `WebFetch` check returned 403, which is more likely this environment's own
  proxy restrictions than the real public page's status). **Next action:** ask the maintainer
  to confirm whether `https://mathiastornblom.github.io/net.tornbloms.mammotion/` actually
  loads for them, and whether the branch's source content exists anywhere to rebuild from,
  before attempting any recreation.

## P1 — High value, unblocked, ready to scope

- **Homey dashboard widgets** (SDK 3 `widgets` — small glanceable cards distinct from device
  tiles/Flow cards). Explicitly requested by the maintainer. Not yet scoped. Good starting
  candidates: at-a-glance mower status + battery + progress card; a start/dock quick-action
  widget; a connection-type (BLE/Cloud) indicator. Pick 2-4 focused widgets, not one crowded
  dump of every capability.
- **Monitor Sentry for real crash signal.** Crash reporting shipped in v2.3.0. Check
  `tornblomsnet` org / `mammotion-homey` project periodically (Sentry MCP is connected) — now
  that the app has ~180 users (as of the 2026-07 forum announcement), there should be enough
  volume for real signal.

## P2 — Medium value, low-to-medium complexity

- **Wildlife Safety mode** — proto field already exists (`set_special_mode_t`,
  `mctrl_sys.proto`) — low complexity, mostly a command builder + capability + Flow card.
- **Charging limit (80% / 100% / Custom)** — needs sys command research first (field exists
  but exact request shape not yet confirmed against pymammotion).
- **EcoSleep / LiveSleep toggles** — `dev_low_power_set_info` in `mctrl_sys.proto` — low
  complexity but also low expected user value; only worth it if requested.

## P3 — Large, deferred, needs its own planning pass when picked up

- **Full Maps & Zones (Phase 5)** — protobuf RTK map data, SVG zone overlays. Zone *selection*
  for Start Mowing has already shipped in stages (see below) without full map sync; this item
  is specifically the visual map/zone-editing feature, which is still very complex and
  deserves its own `docs/MAPS_PLAN.md` before any implementation starts, same pattern as
  `BLE_PLAN.md`/`PROTOCOL_PLAN.md`/`ALIYUN_LEGACY_PLAN.md`.
- **Schedule write support** — struct already known from the existing read-only
  `read_schedule` action, but requires `zone_hashs` which depend on the full Maps/Zones phase
  above — blocked on that, not independently schedulable.

## Explicitly not planned (Phase 7, skip unless priorities change)

- **Firmware OTA** — skip.
- **Camera / Agora WebRTC** — skip, high complexity for uncertain value.

## P1 — High value, unblocked, ready to scope (continued)

- **Start a saved Mammotion-app schedule from Homey.** Scoped 2026-07-19 in
  `docs/SCHEDULE_START_PLAN.md` following a forum request: user configures mowing "tasks" (zones,
  blade height, speed, per-zone cutting angle) in the official app and wants to trigger them in
  sequence from Homey, reusing those exact settings. Found a direct `plan_task_execute` command
  (pymammotion's `single_schedule(plan_id)`, HA's per-schedule buttons) already expressible in our
  current protocol descriptor with zero regeneration — no schedule write/create/edit involved, so
  none of `docs/SCHEDULING_PLAN.md`'s rejection reasons apply. Confirmed gap: our existing
  `start_mowing_zone` action hardcodes `toward:0`/`towardIncludedAngle:0` and can't reproduce a
  per-zone cutting angle at all, so Flow-chaining the existing zone action doesn't fully cover
  this user's need. Recommended scope: a `start_mowing_schedule` autocomplete action (name→plan_id)
  plus a new `mower_job_finished` trigger (progress≈100 + returning/docked transition — no
  "job complete" work mode exists to key off directly). **Needs live hardware verification**
  before shipping (same class of risk as the legacy Aliyun subsystem) — the reporting forum user
  is a plausible test partner.

- **Confirm remaining Yuka models.** A community member ("Ramstein") confirmed Yuka Mini 800
  works via the app's existing generic aliyun_legacy pairing path — no Yuka-specific code was
  needed (`lib/mammotion/deviceType.ts` already resolves Yuka device types and gates
  capabilities for the whole Yuka family). README now documents this and invites the community
  to confirm the remaining Yuka models (Mini 2, VP, ML, MiniV, base Yuka) the same way. No
  action needed unless/until reports come in — this is a low-effort, community-driven way to
  broaden confirmed device support without guessing.

## Recently shipped (context for what's no longer open)

- **Legacy Aliyun IoT device support — verified live, no longer P0.** What was an unverified
  P0 item as of v2.4.0 has since been exercised live by multiple real accounts across dozens of
  point releases (v2.4.1 → v2.5.54): persisted expiry-aware credentials + circuit breaker
  (v2.5.13), 429 rate-limit recovery (v2.5.15, v2.5.53), auto-relogin after sustained handshake
  failures (v2.5.36), and — most recently — explicit HTTP timeouts across every Aliyun/Mammotion
  request path so a blocked network route fails fast instead of hanging for minutes past
  Homey's own ~30s pairing-UI timeout (v2.5.54, `lib/mammotion/aliyun/gateway.ts` +
  `lib/mammotion/auth/MammotionAuth.ts` + `lib/mammotion/mqtt/MqttClient.ts`). Full writeup:
  `docs/ALIYUN_MQTT_TRANSPORT_PLAN.md`.
- **Zone-aware Start Mowing (Phases 1-3)** — v2.5.48 (plan a route before a bare start),
  v2.5.49 ("Start mowing zone..." Flow action), v2.5.51 (unnamed-zone boundary fallback so
  zones without a name set in the official app still enumerate), plus v2.5.52 documenting that
  naming zones in the official Mammotion app improves selection reliability. See
  `docs/ZONE_SELECTION_PLAN.md` and `docs/ZONE_BOUNDARY_FALLBACK_PLAN.md`.
- **Per-model capability differentiation** — see `docs/CAPABILITY_DIFFERENTIATION_PLAN.md`
  (status tracked in that file).
- **Wheel-lift/emergency-stop fault diagnostics** — investigation ongoing via structured
  captures, not yet root-caused; see `docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md` for current
  state.
- **LED ring status feedback — superseded**, current hardware (Homey Pro Early 2023/2026) can
  only use Homey's built-in "Then → LED ring" Flow actions, not a programmatic animation API;
  see `docs/LEDRING_STATUS_PLAN.md`.

## Ongoing maintenance (not features, but don't ignore)

- **i18n completeness drift** — `homey app validate` does NOT check translation completeness
  across the 13 official languages; manually audit after any new setting/dropdown/hint/flow
  card. See `.claude/agents/technical-writer.md` and architecture-decisions memory #12.
- **~86 pre-existing lint errors** — style debt, lint isn't in the CI gate. Don't panic-fix
  in unrelated PRs; a dedicated cleanup pass is fine to schedule but isn't urgent.
- **Dependabot `minimatch` alert** — intentionally left unfixed (transitive devDependency
  only, never shipped, a previous fix attempt broke `eslint-plugin-import`). Don't re-attempt
  unless `eslint-config-athom` ships a version with patched deps. (If a *new*, separate
  Dependabot high-severity alert shows up — one was flagged mid-session on 2026-07-15 but never
  triaged — check what it actually is before assuming it's this same known one.)
