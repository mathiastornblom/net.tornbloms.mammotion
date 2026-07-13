# Mammotion Homey App — Claude Code Project Brief

## What this app is
A Homey SDK 3 app that integrates Mammotion robot lawn mowers (Luba 2, Luba 3) into the Homey smart home platform. Ported from the Home Assistant integration at https://github.com/mikey0000/Mammotion-HA. Pure TypeScript, no Python dependency.

## GitHub
`https://github.com/mathiastornblom/net.tornbloms.mammotion`

## Platform
- **Homey SDK 3** (`homey` npm package, `@types/homey`)
- **Node.js** runtime inside Homey (no native addons)
- **TypeScript** strict mode throughout
- **Minimum Homey firmware:** `>=12.4.0`

## Target Devices
- **Luba 2** series (primary — developer-owned)
- **Luba 3** (secondary target, same protocol family)
- Yuka and Spino deferred to later phases

## Connectivity (both, from day one)
1. **Cloud / MQTT** — Aliyun IoT (Chinese cloud), MQTT over TLS. Requires a dedicated second Mammotion account (primary account gets kicked out of the mobile app). Auth via Aliyun HTTP APIs.
2. **BLE** — Bluetooth LE directly from Homey hub. Local, no cloud. Homey built-in BLE API.

## Reference Source
Clone `https://github.com/mikey0000/Mammotion-HA` to understand the protocol.
The core Python library is `pymammotion` — we port it to TypeScript.
Key files to study:
- `custom_components/mammotion/coordinator.py` — MQTT + BLE transport orchestration
- `custom_components/mammotion/const.py` — all config constants
- `custom_components/mammotion/sensor.py` — sensor capabilities
- `custom_components/mammotion/lawn_mower.py` — mow commands and parameters

## Architecture
```
net.tornbloms.mammotion/
├── app.ts                        # App entry — init, credentials check
├── drivers/
│   └── luba/
│       ├── driver.ts             # BLE discovery + cloud device listing + pairing
│       └── device.ts            # Capabilities, polling, command dispatch
├── lib/
│   ├── mammotion/               # TypeScript port of pymammotion
│   │   ├── auth/
│   │   │   ├── AliyunAuth.ts    # HTTP auth against Aliyun, token refresh
│   │   │   └── types.ts
│   │   ├── mqtt/
│   │   │   ├── MammotionMqtt.ts # MQTT over TLS, subscribe, publish
│   │   │   └── topics.ts        # Topic patterns
│   │   ├── ble/
│   │   │   ├── BleTransport.ts  # Homey BLE API wrapper
│   │   │   └── protocol.ts      # BLE characteristic UUIDs
│   │   ├── protocol/
│   │   │   ├── proto/           # .proto files copied from pymammotion
│   │   │   └── Codec.ts         # protobufjs encode/decode
│   │   ├── commands/
│   │   │   └── MowerCommands.ts # start_mow, stop, dock, set_blade_height, etc.
│   │   └── client/
│   │       └── MammotionClient.ts # Unified client (picks cloud or BLE)
│   └── util/
│       ├── Retry.ts
│       └── Logger.ts
├── locales/
│   ├── en.json
│   └── nl.json
└── assets/
```

## Homey Capabilities (driver manifest)
### Control
- `lawnmower_state` (mowing / charging / docked / error) — built-in Homey class
- `onoff` (start / stop convenience)

### Sensors
- `measure_battery` — battery %
- `measure_wifi_rssi` — WiFi signal
- `measure_ble_rssi` — BLE RSSI
- `measure_gps_stars` — GPS satellite count
- `measure_area` — mowed area (m²)
- `measure_mowing_speed` — speed (m/s)
- `measure_progress` — job progress (%)
- `measure_elapsed_time` — elapsed (min)
- `measure_left_time` — remaining (min)
- Custom: `blade_height`, `blade_used_time`, `pos_level`

### Homey Flow Cards
**Triggers:** mower started, mower docked, mower error, battery below X%
**Conditions:** is mowing, battery above X%, GPS signal good
**Actions:** start mowing (with full parameter set), stop, dock, pause, set blade height

## Mow Command Parameters (from lawn_mower.py)
```typescript
interface StartMowOptions {
  is_mow?: boolean;           // default true
  is_dump?: boolean;          // default true (grass collection)
  is_edge?: boolean;          // default false
  blade_height?: number;      // 15–100 mm, default 25
  speed?: number;             // 0.2–1.2 m/s, default 0.3
  channel_width?: number;     // 5–35 cm, default 25
  channel_mode?: 0|1|2|3;    // mowing pattern
  rain_tactics?: 0|1;        // 0=stop, 1=continue
  areas?: string[];           // zone IDs
  job_id?: number;
}
```

## Advanced Features (Phase 3+)
- **Map sync:** SVG zone overlays, RTK positioning (requires Protobuf parsing)
- **Scheduling:** Create/edit mowing schedules via Flows
- **Firmware OTA:** Trigger update from Homey
- **Camera stream:** Agora WebRTC (complex — investigate feasibility last)

## Key npm Dependencies
```json
{
  "dependencies": {
    "mqtt": "^5.x",
    "protobufjs": "^7.x"
  },
  "devDependencies": {
    "homey": "^3.x",
    "@types/homey": "npm:homey-apps-sdk-v3-types",
    "typescript": "^6.x"
  }
}
```

## Test Account
A dedicated second Mammotion account must be created and mowers shared to it before cloud testing. (Primary account gets logged out of mobile app when used by an integration.)

## Coding Conventions
- TypeScript strict mode — no `any`, no `!` non-null assertions without comment
- `async/await` only — no callbacks, no raw Promises `.then()`
- Classes for stateful services, pure functions for transforms
- Every public method gets a one-line JSDoc describing what it does (not how)
- Error types: define a `MammotionError` hierarchy (AuthError, CommandTimeoutError, etc.)
- Log with `this.log()` / `this.error()` — Homey's built-in logger

## Git Conventions
- **`main`** mirrors whatever version is actually live/approved on the Homey App Store —
  it only moves forward when a version submitted from `test` has been approved by Homey,
  never ahead of that. Treat it as a snapshot of production, not the integration branch.
- **`test`** is the active development/integration branch — all new work lands here first.
  Homey's build pipeline (GitHub Actions) publishes from `test` to the App Store's test
  track on every push, so this is what gets submitted for review.
- **Sync flow**: once Homey approves a version submitted from `test`, fast-forward/reset
  `main` to that exact commit (so `main`'s version matches what's actually published), then
  keep developing on `test`. Don't merge `test` → `main` speculatively before approval.
- Feature branches: `feature/short-name`, merged into `test` (not `main`) via PR.
- Commit: imperative mood — `Add MQTT auth client`, `Port start_mow command`
- Never commit credentials or tokens

## Homey App Store Requirements
- Pure Node.js — no native addons, no child_process spawning external binaries
- All network requests must go through Homey's `https` module or standard `fetch`
- App ID: `net.tornbloms.mammotion`
- **No embedded secrets in source** (flagged by Homey review, fixed v2.5.37). Per
  https://apps.developer.homey.app/the-basics/app (confirmed by reading the actual page):
  `env.json` lives at the app root, belongs in `.gitignore`, holds flat uppercase-keyed
  string values, and is documented as readable anywhere via `Homey.env.KEY_NAME` (`import
  Homey from 'homey'`). It's populated on the real device at install/publish time and isn't
  meant to be readable by anyone else — but per that page's own hint, don't assume it alone
  gates access to anything sensitive. `lib/util/homeyEnv.ts`'s `HOMEY_ENV` wraps this: reads
  `Homey.env` when genuinely populated, else falls back to reading `env.json` off disk
  directly (`homey app build` generates a local circular-shim `homey` package purely so
  static imports resolve — it silently resolves to `{}` rather than throwing, so detect via
  `.env` truthiness, not try/catch). Repo secrets are written to `env.json` in CI before
  publish (`.github/workflows/homey-app-publish.yml`). Never hardcode a new key/secret as a
  string literal — add it to `HOMEY_ENV.<NAME>` instead, and to both `env.json` and the
  GitHub repo secrets + publish workflow.

## Phases
| Phase | Weeks | Goal |
|-------|-------|------|
| 1 — Foundation | 1–2 | Auth + MQTT connect + device list + BLE discovery proof |
| 2 — Core Control | 3–4 | Start/stop/dock/pause + battery/status + first Flow cards |
| 3 — All Sensors | 5–6 | Full sensor set, all Flow triggers/conditions |
| 4 — BLE Transport | 7–8 | BLE pairing, dual-mode transport, fallback logic |
| 5 — Maps & Zones | 9–10 | Protobuf map sync, zone management |
| 6 — Scheduling | 11 | Schedule creation/editing via Flows |
| 7 — Advanced | 12+ | Firmware OTA, camera stream investigation |

## Current status & subagents
Published on the Homey App Store, post-launch (v2.3.5+). Prioritized backlog: `docs/ROADMAP.md`.
Role-specific subagents in `.claude/agents/`: `architect` (research/scoping, opus), `developer`
(implementation), `qa` (verification), `technical-writer` (docs/i18n), `marketing` (App
Store/community copy), `design` (icons/pairing-screen UX).

## Keep this file under 200 lines.
