# BLE transport — analysis & plan

Source of truth: [PyMammotion](https://github.com/mikey0000/PyMammotion)
(`pymammotion/bluetooth/*`, `pymammotion/transport/ble.py`), analyzed 2026-06-30.

## 1. Confirmed facts

**UUIDs** (already in `lib/mammotion/constants.ts`, matches pymammotion's `bluetooth/const.py`):
- Service: `0000ffff-0000-1000-8000-00805f9b34fb`
- Write characteristic: `0000ff01-0000-1000-8000-00805f9b34fb`
- Notify characteristic: `0000ff02-0000-1000-8000-00805f9b34fb`
- Local name prefixes: `Luba-*`, `Yuka-*`

**The payload is the same `LubaMsg` protobuf used over MQTT.** BLE only changes the *framing*
around that payload — `Codec.ts`'s `encodeLubaMsg`/`decodeLubaMsg` are directly reusable.

**Framing is a custom BluFi-derived protocol** (Espressif's ESP32 BLE-provisioning wire format,
confirmed by `EspBleUtil` references in pymammotion's own comments — Mammotion's ESP32 BLE module
reuses this off-the-shelf framing rather than inventing its own):

```
[type:1][frameCtrl:1][sequence:1][dataLength:1][data:N][checksum:2 if frameCtrl.checksum]
```

- `type = (subtype << 2) | packageType`. For our custom-data (protobuf) frames: `packageType=1,
  subtype=19` → `type = 77`.
- `frameCtrl` bits: 0=encrypted, 1=checksum, 2=direction, 3=requireAck, 4=hasFrag (fragmented).
  We send unencrypted, no checksum, no ack-required, by default (matching pymammotion's defaults).
- `sequence`: 0–255 wrapping counter, independent for send vs receive.
- Fragmentation: payload chunked (pymammotion uses 517-byte chunks, i.e. assumes BLE 5
  ATT_MTU≈520 negotiated — **not verified what Homey's BLE stack actually negotiates**, see §3).
  All but the last chunk set `hasFrag`; receiver reassembles by appending chunks until a frame
  arrives with `hasFrag=0`.
- CRC16 (custom table, `calc_crc`) only used when `frameCtrl.checksum` is set — we don't set it,
  so not required for v1, but the table is captured in pymammotion source if needed later.
- Received frame dispatch: `pkgType` (bits 0–1 of `type`) — `0`=ctrl/ack (we never seem to receive
  these in practice), `1`=data. `subType` (bits 2–7) — `19` = custom data = our protobuf payload.

**Connection handshake**: after `start_notify`, pymammotion sends a one-shot
`send_todev_ble_sync(2)` — a `DevNet{todev_ble_sync: 2}` message (`LubaMsg.net`, field 8). **Our
trimmed `luba_msg.proto` (done during the MQTT/protobuf rewrite) removed the `net`/`DevNet` branch
to save bundle size — it must be restored for BLE.** Field number (8) is unchanged so this is
additive, not breaking.

**Reconnection/backoff**: pymammotion tracks consecutive failures, has a cooldown (120s default),
and gates connection attempts on RSSI (`min_rssi=-90`) — an advertisement below that threshold
isn't worth attempting a GATT connect on. Mirrors the MQTT lesson already learned: don't blindly
retry, and don't trust every signal as connectable.

## 2. Homey BLE API → pymammotion/bleak mapping (verified against `@types/homey`)

| pymammotion/bleak | Homey SDK3 equivalent |
|---|---|
| `BleakScanner` (find by address/name) | `this.homey.ble.discover([serviceUuid])` → `BleAdvertisement[]` (has `localName`, `connectable`, `rssi`) |
| `establish_connection(...)` | `advertisement.connect()` → `BlePeripheral` |
| service/characteristic discovery | `peripheral.discoverServices([UUID_SERVICE])` → `service.getCharacteristic(uuid)` |
| `client.write_gatt_char(..., response=True)` | `characteristic.write(buffer)` |
| `client.start_notify(uuid, handler)` | `characteristic.subscribeToNotifications(callback)` — **exists, confirmed in BleCharacteristic.d.ts, `@since 6.0.0`** |
| disconnect callback | no direct Homey equivalent found; poll `peripheral.isConnected` |

**Conclusion: Homey's BLE API has everything needed.** No capability gap.

## 3. Open questions that REQUIRE a real device to answer

1. **MTU / max write size.** pymammotion hardcodes 517-byte chunks assuming a negotiated ATT_MTU.
   Homey's `BleCharacteristic.write()` doesn't expose MTU negotiation or a documented max size.
   **Plan: start conservative** — use pymammotion's own fallback constant
   (`MIN_PACKAGE_LENGTH = 20` bytes) as the default chunk size, verify against a real connection,
   only raise it if confirmed safe. Wrong here fails closed (more fragments, not corruption).
2. **Whether Homey's BLE stack on a Homey Pro/3s can sustain a persistent peripheral connection
   alongside Wi-Fi/Zigbee/Z-Wave radio traffic** — unknown until tested on the actual hub.
3. **Whether BLE is even in range/useful for this user's setup** — the mower lives outdoors;
   Homey's BLE range to a garden mower may be marginal. This may end up being a "nice to have,
   rarely active" fallback rather than a primary transport in practice.

## 4. Scope decision for this pass

Given (1) BLE framing logic (BluFi codec: header pack/unpack, sequence tracking, fragment
reassembly) is **pure and fully unit-testable without hardware** — build it now, same as the
protobuf codec.
Given (2) the *transport* (Homey BLE discover/connect/subscribe/write orchestration, reconnect
policy, dual-mode fallback decision in `device.ts`) **cannot be validated without a real device**
and the open questions in §3 — build a first version, but do **not** wire it into the live
device's primary data path yet. Loudly flag (like the protobuf decode-failure logging) so the
first real-device test is conclusive rather than silently wrong.

Defer entirely for now: dual-mode transport *selection* policy (when to prefer BLE vs MQTT),
encryption/checksum support (frameCtrl bits we don't currently set), RSSI-gated cooldown logic —
all of these are policy decisions best made after confirming the basic link works at all.
