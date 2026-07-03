# Roadmap & prioritized backlog

Last reviewed: 2026-07-03, app version v2.3.5. This is the single source of truth for "what's
next" — check here before starting new work. Update this file (not just memory) whenever
priority shifts, since it's versioned with the code and visible to anyone reading the repo.

## P0 — Active / blocking

- **Legacy Aliyun IoT device support — CONFIRMED, implementation plan ready, not yet built.**
  v2.3.5's read-only diagnostic probe found `bound=1 shareNotifications=2` on a real affected
  account (Anders_Gregow / mammotion_homey@gregow.se) — hypothesis confirmed, and all three
  hand-transcribed signing algorithms proven working against a live Aliyun server for the
  first time. Full read+write implementation plan (same-driver decision, write path via the
  already-proven signing scheme, new `AliyunMqttTransport` for telemetry, staged rollout,
  risk assessment): `docs/ALIYUN_MQTT_TRANSPORT_PLAN.md` (companion to
  `docs/ALIYUN_LEGACY_PLAN.md`, which has the background).
  **Recommendation:** same `luba` driver, internal `transportKind` flag — not a separate
  driver (see plan doc §1 for reasoning).
  **Next action:** Stage 0 (small, near-zero risk — retain already-fetched credentials,
  extract shared signing helper) can start anytime. Stage 1 (write path) and Stage 2 (MQTT
  read path) both have zero live-server verification — reaching out to the confirmed
  affected user for test access before enabling broadly would close that gap and is worth
  pursuing in parallel, not a blocker for starting Stage 0/1.

## P1 — High value, unblocked, ready to scope

- **Homey dashboard widgets** (SDK 3 `widgets` — small glanceable cards distinct from device
  tiles/Flow cards). Explicitly requested by the maintainer. Not yet scoped. Good starting
  candidates: at-a-glance mower status + battery + progress card; a start/dock quick-action
  widget; a connection-type (BLE/Cloud) indicator. Pick 2-4 focused widgets, not one crowded
  dump of every capability.
- **Monitor Sentry for real crash signal.** Crash reporting shipped in v2.3.0 — nothing has
  been triaged from it yet since it's new. Check `tornblomsnet` org / `mammotion-homey`
  project periodically (Sentry MCP is connected) once there's enough install base for signal.

## P2 — Medium value, low-to-medium complexity

- **Wildlife Safety mode** — proto field already exists (`set_special_mode_t`,
  `mctrl_sys.proto`) — low complexity, mostly a command builder + capability + Flow card.
- **Charging limit (80% / 100% / Custom)** — needs sys command research first (field exists
  but exact request shape not yet confirmed against pymammotion).
- **EcoSleep / LiveSleep toggles** — `dev_low_power_set_info` in `mctrl_sys.proto` — low
  complexity but also low expected user value; only worth it if requested.

## P3 — Large, deferred, needs its own planning pass when picked up

- **Schedule write support** — struct already known from the existing read-only
  `read_schedule` action, but requires `zone_hashs` which depend on the Maps/Zones phase
  below — blocked on that, not independently schedulable.
- **Maps & Zones (Phase 5)** — protobuf RTK map data, SVG zone overlays. Very complex,
  deserves its own `docs/MAPS_PLAN.md` before any implementation starts, same pattern as
  `BLE_PLAN.md`/`PROTOCOL_PLAN.md`/`ALIYUN_LEGACY_PLAN.md`.

## Explicitly not planned (Phase 7, skip unless priorities change)

- **Firmware OTA** — skip.
- **Camera / Agora WebRTC** — skip, high complexity for uncertain value.

## Ongoing maintenance (not features, but don't ignore)

- **i18n completeness drift** — `homey app validate` does NOT check translation completeness
  across the 13 official languages; manually audit after any new setting/dropdown/hint/flow
  card. See `.claude/agents/technical-writer.md` and architecture-decisions memory #12.
- **~86 pre-existing lint errors** — style debt, lint isn't in the CI gate. Don't panic-fix
  in unrelated PRs; a dedicated cleanup pass is fine to schedule but isn't urgent.
- **Dependabot `minimatch` alert** — intentionally left unfixed (transitive devDependency
  only, never shipped, a previous fix attempt broke `eslint-plugin-import`). Don't re-attempt
  unless `eslint-config-athom` ships a version with patched deps.
