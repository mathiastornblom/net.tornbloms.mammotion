# Roadmap & prioritized backlog

Last reviewed: 2026-07-03, app version v2.3.5. This is the single source of truth for "what's
next" — check here before starting new work. Update this file (not just memory) whenever
priority shifts, since it's versioned with the code and visible to anyone reading the repo.

## P0 — Active / blocking

- **Legacy Aliyun IoT device support (in progress, blocked on external signal).**
  v2.3.5 shipped a read-only diagnostic probe (`lib/mammotion/aliyun/AliyunLegacyProbe.ts`)
  for a second, independent Mammotion cloud device system that this app has never supported.
  **Waiting on:** an invite to test against a real affected account (Anders_Gregow /
  mammotion_homey@gregow.se, 2 mowers, confirmed visible in the Android app but invisible to
  this app), or the next diagnostic report from that account on v2.3.5+.
  **Next step once confirmed:** build `AliyunMQTTTransport` — a second, fully separate MQTT
  transport (different broker, topics, credential scheme) to actually control legacy-bound
  devices. Real, bounded-but-nontrivial effort; the wire payload reuses the existing protobuf
  `LubaMsg` codec, so this is "new transport/auth layer," not "new protocol from scratch."
  Full technical detail: `docs/ALIYUN_LEGACY_PLAN.md`.
  **If the probe turns out wrong** (finds nothing, or throws due to a signing bug): re-verify
  the three signing algorithms against pymammotion's Python source step by step before
  concluding the whole hypothesis is wrong.

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
