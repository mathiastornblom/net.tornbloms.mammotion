# Forum post text — paste this into community.homey.app

**Category:** Apps
**Title:** `[APP][Pro] Mammotion - Control your Mammotion robot mower`
**Tags:** `robot-mower`, `bluetooth`, `homey-pro`

---

Mammotion brings your Luba 2 or Luba 3 robot lawn mower into Homey. Start, pause, stop, or send it back to the dock, adjust blade height and cutting speed on the fly, and keep an eye on everything from battery level to RTK positioning accuracy — all from your device tile or a Flow.

It's a ground-up TypeScript port, not a Python wrapper — pure Node.js, fully native to the Homey SDK.

## Features

**Control**
- Start / pause / stop / send to dock
- Adjustable blade height and cutting speed (Low / Medium / High)
- Headlamp, side LED and rain protection toggles

**Sensors**
- Battery level, charge cycles, blade wear
- Mowed area and progress, mowing speed, elapsed/remaining time
- WiFi and Bluetooth signal strength
- GPS satellite count and RTK positioning accuracy (No Fix / GNSS / Float / RTK Fixed)
- Connection type (shows whether you're on Bluetooth or cloud right now)

**Flow cards**
- Triggers: mower started mowing, mower docked, mower reported an error, battery below X%
- Conditions: is mowing, battery above X%, GPS signal good
- Actions: start mowing (with blade height/speed/edge options), dock, pause, stop, set blade speed, set rain protection, read stored schedule

**Dual transport**
Connects over the cloud by default and switches to a direct Bluetooth connection automatically when your mower is in range — faster, more local control with cloud as the reliable fallback. You can also force Bluetooth-only or cloud-only from the device settings.

## Getting started

1. Install the app from the Homey App Store: https://homey.app/a/net.tornbloms.mammotion
2. Add a device — the pairing wizard walks you through setting up a **dedicated second Mammotion account** first (Mammotion's mobile app logs you out whenever another app signs in with the same account, so your daily-driver account isn't practical): create a new account → invite it from your normal account (sharing your mower) → accept the invite on the new account → come back and log in here with it. You only do this once.
3. Homey will then list every mower (owned or shared) visible to that account.

If your account credentials change later, use the device's **Repair** flow instead of deleting and re-adding it — your Flows and Insights history stay intact.

## Screenshots

*(attach a couple of screenshots here: the device tile, the mobile/timeline view, and a Flow example)*

## Links

- App Store: https://homey.app/a/net.tornbloms.mammotion
- Source code: https://github.com/mathiastornblom/net.tornbloms.mammotion
- Bug reports / feature requests: https://github.com/mathiastornblom/net.tornbloms.mammotion/issues

## Feedback welcome

This is an actively developed app — Bluetooth reliability in particular is still being tuned across different Homey hub models, so diagnostic reports are genuinely useful if something doesn't work as expected. Feel free to post here or open a GitHub issue.

## Acknowledgements

This app builds on reverse-engineering work already done by the community:

- **[mikey0000/Mammotion-HA](https://github.com/mikey0000/Mammotion-HA)** — the Home Assistant integration and its `pymammotion` library are the primary reference for the protocol layer (cloud auth, MQTT, protobuf messages, Bluetooth framing). Large parts of this app are a direct TypeScript port of that work.
- **[Lindhardsen/homey-mammotion](https://github.com/Lindhardsen/homey-mammotion)** — an independent, parallel Homey integration that helped confirm protocol details during development.
- **[DNAngelX/ioBroker.mammotion](https://github.com/DNAngelX/ioBroker.mammotion)** — its product-key reference table helped catch a real command-routing bug in this app.

Thanks to all three for the groundwork.
