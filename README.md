# Mammotion for Homey

A [Homey](https://homey.app) app that brings Mammotion robot lawn mowers (Luba 2, Luba 3) into your smart home. Pure TypeScript, no Python sidecar — ported from the ground up to run natively on Homey SDK 3.

## Features

- **Control:** start, pause, stop, dock — with adjustable blade height and cutting speed
- **Lighting & weather:** headlamp, side LED, rain protection
- **Sensors:** battery level, charge cycles, blade wear, mowed area, progress, mowing speed, elapsed/remaining time, WiFi and Bluetooth signal, GPS satellite count, RTK positioning accuracy
- **Flow cards:** triggers for mowing started/docked/error/low battery, conditions for mowing state/battery/GPS signal, actions for every control above
- **Dual transport:** connects over the cloud (MQTT) by default and switches to a direct Bluetooth connection automatically when the mower is in range — local control, no round-trip to the cloud
- **Repair flow:** update your Mammotion account credentials without deleting and re-pairing the device

## Supported devices

- Luba 2 (primary target)
- Luba 3 (same protocol family)

Yuka and Spino are not yet supported.

## Installation

Install from the [Homey App Store](https://homey.app/apps/) once published, or for development:

```bash
npm install
npm run build
npx homey app run
```

Pairing walks you through setting up a **dedicated second Mammotion account** before asking for login credentials — Mammotion's mobile app logs you out whenever another app (like Homey) signs in with the same account, so using your primary account isn't practical. The in-app instructions cover: create a new account → invite it from your normal account (sharing your mower) → accept the invite on the new account → come back and log in here with it. You only do this once; your normal account keeps working in the Mammotion app exactly as before.

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
