# Mammotion for Homey

A [Homey](https://homey.app) app that brings Mammotion robot lawn mowers (Luba 2, Luba 3) into your smart home. Pure TypeScript, no Python sidecar — ported from the ground up to run natively on Homey SDK 3.

## Features

- **Control:** start, pause, stop, dock — with adjustable blade height and cutting speed
- **Lighting & weather:** headlamp, side LED, rain protection
- **Sensors:** battery level, charge cycles, blade wear, mowed area, progress, mowing speed, elapsed/remaining time, WiFi and Bluetooth signal, GPS satellite count, RTK positioning accuracy
- **Saved tasks and zones:** run any task you set up in the Mammotion app ("Start mowing task"), mow one named zone ("Start mowing zone"), and chain tasks back to back with the "Mower finished a mowing job" trigger, which tells you which task just ended
- **Flow cards:** triggers for mowing started/docked/error/low battery, conditions for mowing state/battery/GPS signal, actions for every control above, including pause and resume
- **Dual transport:** connects over the cloud (MQTT) by default and switches to a direct Bluetooth connection automatically when the mower is in range — local control, no round-trip to the cloud
- **Repair flow:** update your Mammotion account credentials without deleting and re-pairing the device

## Supported devices

- Luba 2 (primary target)
- Luba 3 (same protocol family)
- Yuka Mini 800 — confirmed working by a community member (2026-07-16, same pairing/cloud path as Luba, no Yuka-specific code needed)
- Yuka Mini 2 1000 — confirmed working by a community member (2026-08-06, Homey Community forum)

Other Yuka models (Yuka, Yuka VP, Yuka ML, Yuka MiniV) use the same underlying protocol family and are expected to work the same way, but haven't been confirmed yet — if you pair one successfully, please [open an issue](https://github.com/mathiastornblom/net.tornbloms.mammotion/issues) or post in the [Homey Community topic](https://community.homey.app/t/app-pro-mammotion/156754) to confirm it for others. Spino is not yet confirmed either way.

## Installation

Install from the [Homey App Store](https://homey.app/apps/) once published, or for development:

```bash
npm install
npm run build
npx homey app run
```

Pairing walks you through setting up a **dedicated second Mammotion account** before asking for login credentials — Mammotion's mobile app logs you out whenever another app (like Homey) signs in with the same account, so using your primary account isn't practical. The in-app instructions cover: create a new account → invite it from your normal account (sharing your mower) → accept the invite on the new account → come back and log in here with it. You only do this once; your normal account keeps working in the Mammotion app exactly as before.

## Tip: name your mowing zones

The "Start mowing zone" Flow action picks from the zones your mower already knows. If a mower's zones have never been named, this app can still discover and mow them, but it has to fall back to a slower on-the-fly boundary scan (roughly 20 seconds) every time, and the result isn't kept in sync with the official app.

For instant, reliable zone selection, open the mower in the official Mammotion iOS/Android app and give each zone a name (e.g. "Front lawn", "Back garden"). Once named there, this app picks them up immediately under their real names — no scan needed.

## Tip: run your saved tasks from Homey

The "Start mowing task" Flow action lists the tasks you have set up in the Mammotion app and runs one exactly as you configured it there — same zones, cutting height, speed and mowing angle. Homey sends nothing but "run this task", so it is the safest way to start the mower from a Flow. The generic "Start mowing" card and the on/off toggle plan a fresh route instead; they now reuse the cutting height and line spacing from your saved tasks, but they cannot reproduce a task's zones or angle.

**Avoid the task running twice.** A task in the Mammotion app is both a set of mowing settings *and* a schedule. If Homey starts it and the app's own schedule also fires, the mower runs it twice. Pause the task's schedule in the Mammotion app (it stays paused there, but Homey can still start it) so that only your Flow decides when it runs. A community member found this; it is not obvious, and everyone who chains tasks needs it.

**Chaining tasks.** The "Mower finished a mowing job" trigger fires as soon as a job reaches roughly 100 % and the mower turns for home, and it carries a *Task* tag with the task's name. A Flow that matches on that tag and calls "Start mowing task" for the next one runs your whole lawn as a queue. The app pauses the return to the dock automatically before the next start, so no manual pause or delay cards are needed. If you set that up on an earlier version, the workaround keeps working but you can remove it.

**Paused mid-lawn?** "Resume mowing" continues the current job where it stopped. "Start mowing" or "Start mowing task" would plan the route again and start from the beginning.

## Development

```bash
npm run build          # compile TypeScript
npm test               # run all test suites
npm run proto:gen      # regenerate the protobuf descriptor after editing a .proto file
npx homey app validate --level publish
```

See [CLAUDE.md](CLAUDE.md) for the full architecture brief, and `docs/` for protocol, BLE and scheduling research notes.

## Acknowledgements

This app would not exist without the reverse-engineering work already done by the community:

- **[mikey0000/Mammotion-HA](https://github.com/mikey0000/Mammotion-HA)** — the Home Assistant integration and its underlying `pymammotion` library are the primary reference for this app's protocol layer (Aliyun cloud auth, MQTT topics, protobuf message shapes, BLE/BluFi framing). Large parts of this app are a direct TypeScript port of that work.
- **[Lindhardsen/homey-mammotion](https://github.com/Lindhardsen/homey-mammotion)** — an independent, parallel Homey integration that helped confirm several protocol details during development.
- **[DNAngelX/ioBroker.mammotion](https://github.com/DNAngelX/ioBroker.mammotion)** — its auto-generated product-key table (derived from `pymammotion`'s device type enum) helped catch a real command-routing bug in this app's device-type detection.

Thank you to the maintainers and contributors of all three projects.

## License

GPL-3.0 — see [LICENSE](LICENSE).
