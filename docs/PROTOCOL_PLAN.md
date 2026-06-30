# Mammotion protocol — analysis & correct implementation plan

Source of truth: [PyMammotion](https://github.com/mikey0000/PyMammotion) and
[Mammotion-HA](https://github.com/mikey0000/Mammotion-HA), analyzed 2026-06-30.

This document captures the **verified** protocol details (with proto field numbers
quoted from `pymammotion/proto/*.proto`) and the plan to make our TypeScript port
correct. It exists because the initial port hand-rolled protobuf encoding/decoding
with **guessed** field numbers, which is why telemetry never appeared.

---

## 1. What we confirmed is ALREADY correct

- **Auth / login** — works (logs show successful auth). Our OAuth2 HMAC flow against
  `id.mammotion.com/oauth2/token` returns a valid JWT; we extract the `iot` domain
  claim correctly.
- **Device listing** — `records` (owned+shared, `{iot}/v1/user/device/page`) is the
  authoritative list; `device/list` is owned-only. Fixed in 1.1.3.
- **MQTT connection** — JWT broker creds from `{iot}/v1/mqtt/auth/jwt`; connect with
  `clean_session`, keepalive 60, protocol V3.1.1 (=4), TLS on 8883. JWT is single-use
  for reconnect → must refetch creds each connect (fixed 1.2.1).
- **Subscribe topics** — exactly three, per `MQTTTransport`:
  - `/sys/{pk}/{dn}/thing/event/+/post`
  - `/sys/proto/{pk}/{dn}/thing/event/+/post`
  - `/sys/{pk}/{dn}/app/down/thing/status`
  Extra topics get the whole connection killed by Aliyun ACL (fixed 1.2.2).
- **Invoke endpoint** — `{iot}/v1/mqtt/rpc/thing/service/invoke`, identifier
  `device_protobuf_sync_service` (fixed 1.2.4).
- **Message dispatch** — only `device_protobuf_msg_event` carries telemetry; unwrap
  `params.value.content` or `params.content` (base64 → protobuf). Fixed 1.2.4.
- **LubaMsg envelope field numbers** — verified against `luba_msg.proto`:
  `msgtype=1, sender=2, rcver=3, msgattr=4, seqs=5, version=6, subtype=7, sys=10,
  nav=11, timestamp=15`. Our envelope is correct.
- **Message-type constants** — verified: `NAV=240, EMBED_DRIVER=243, EMBED_SYS=244`.
  Our magic numbers happen to be right.
- **Device routing** — `DEV_MAINCTL=1, DEV_MOBILEAPP=7, DEV_NAVIGATION=17`.

---

## 2. The two REAL remaining bugs (why no data shows)

### Bug A — telemetry-request subscription list is wrong/incomplete

`get_report_cfg` builds `LubaMsg.sys(10) → MctlSys.todev_report_cfg(38) →
report_info_cfg`:

```
report_info_cfg { act=1, timeout=2, period=3, no_change_period=4, count=5, repeated sub=6 }
rpt_act:    RPT_START=0, RPT_STOP=1, RPT_KEEP=2
```

`rpt_info_type` (verified enum):
`RIT_CONNECT=0, RIT_DEV_STA=1, RIT_RTK=2, RIT_DEV_LOCAL=3, RIT_WORK=4, RIT_FW_INFO=5,
RIT_MAINTAIN=6, RIT_VISION_POINT=7, RIT_VIO=8, RIT_VISION_STATISTIC=9,
RIT_BASESTATION_INFO=10, RIT_CUTTER_INFO=11`.

pymammotion subscribes to: `[0,2,3,4,1,7,8,9,10,5]`
(CONNECT, RTK, DEV_LOCAL, WORK, DEV_STA, VISION_POINT, VIO, VISION_STATISTIC,
BASESTATION_INFO, FW_INFO).

We currently send `[1,3,4,6,10,8]` — **missing `RIT_CONNECT`(0)** (wifi/ble rssi)
and **`RIT_RTK`(2)** (gps), and we wrongly include `RIT_MAINTAIN`(6).

### Bug B — telemetry RESPONSE parsing reads the wrong fields entirely

Telemetry arrives as `LubaMsg.sys(10) → MctlSys.toapp_report_data(39) →
report_info_data`:

```
report_info_data {
  rpt_connect_status connect = 1;   // ble_rssi=2, wifi_rssi=3
  rpt_dev_status     dev     = 2;   // sys_status=1 (work mode), charge_state=2, battery_val=3
  rpt_rtk            rtk     = 3;   // pos_level=2, gps_stars=3
  repeated rpt_dev_location locations = 4;
  rpt_work           work    = 5;   // progress=3, area=4
  device_fw_info     fw_info = 6;
  rpt_maintain       maintain= 7;
  ...
}
```

Our current `handleProtobufMessage` reads `sys → field 1` and `nav(11) → field 22`,
which are **not where any of this data lives**. It should read
`sys(10) → 39 → {dev(2), connect(1), rtk(3), work(5)}` and the leaf fields above.

### Minor — invoke body fields

pymammotion sends `deviceName:""` and `productKey:""` (both empty); only `iotId`
matters. In 1.2.4 we populated them with real values — harmless but should be `""`
to match exactly.

### Minor — notification-driven refresh

Non-telemetry identifiers (`device_biz_req_event`, `device_config_req_event`,
`device_notification_event`, …) mean the device wants the app to react. pymammotion
re-sends the report config on these. We currently ignore them.

---

## 3. Root cause & recommended approach

The initial port **hand-rolled** protobuf encode/decode (`Codec.ts`) with guessed
field numbers in `LubaCommands.ts` and `MqttClient.handleProtobufMessage`. The
envelope happened to be right; the nested report structures were not. Every "no
data" report traces back to this.

**CLAUDE.md already specifies `protobufjs` as a dependency** and describes
`Codec.ts` as "protobufjs encode/decode" — the original intent was to use generated
protobuf types, not hand-rolled byte fiddling. We should align with that intent.

**Recommendation: port the real `.proto` files and use `protobufjs`.**

- Vendor the 10 `.proto` files from `pymammotion/proto/` into
  `lib/mammotion/protocol/proto/`.
- Load them with `protobufjs` (static codegen at build, or runtime `load`).
- Replace `buildRequestIotSyncCommand` and the command builders with typed
  `LubaMsg`/`MctlSys`/`report_info_cfg` construction.
- Replace `handleProtobufMessage` with typed `LubaMsg.decode` → read
  `sys.toapp_report_data.{dev,connect,rtk,work}`.

This removes a whole class of "guessed field number" bugs at once and makes future
work (maps, scheduling) tractable, since those reuse the same generated types.

---

## 4. Capability → proto field mapping (verified)

| Homey capability        | proto path (`report_info_data` = `sys.toapp_report_data`) |
|-------------------------|------------------------------------------------------------|
| `measure_battery`       | `dev.battery_val` (dev=2, battery_val=3)                    |
| `mower_status`/`onoff`  | `dev.sys_status` (=1) + `dev.charge_state` (=2)             |
| `alarm_generic`         | derived from `dev.sys_status` error modes                  |
| `measure_wifi_rssi`     | `connect.wifi_rssi` (connect=1, wifi_rssi=3)               |
| `measure_ble_rssi`      | `connect.ble_rssi` (connect=1, ble_rssi=2)                |
| `measure_gps_stars`     | `rtk.gps_stars` (rtk=3, gps_stars=3)                       |
| `measure_mow_progress`  | `work.progress` (work=5, progress=3)                      |
| `measure_mow_area`      | `work.area` (work=5, area=4)                              |
| `measure_mowing_speed`  | (no direct field — derive or drop)                        |
| `measure_elapsed_time`  | (not in report_info_data — review)                        |
| `measure_left_time`     | (not in report_info_data — review)                        |

Note: `sys_status` is the work-mode integer; reuse the existing `workModeToStatus`
mapping but feed it from the correct field.

---

## 5. Phased plan

1. **Protobuf foundation** — vendor `.proto`, wire up `protobufjs`, generate types,
   add a unit test that round-trips a known `get_report_cfg` payload and decodes a
   captured `device_protobuf_msg_event` fixture.
2. **Fix telemetry request** — `get_report_cfg` with the correct `sub` list and
   `count` (start with `count=0` continuous + periodic re-arm, matching a live view;
   confirm against `mower_api.py` cadence).
3. **Fix telemetry parse** — decode `toapp_report_data`, map per the table above.
4. **Notification-driven re-arm** — on non-protobuf identifiers, re-send report cfg.
5. **Commands** — re-verify start/dock/pause/blade against typed builders.
6. **Regression test** with the real mower; remove diagnostic logging once stable.

Defer (per memory): RTK base station as a separate driver; maps/zones; scheduling;
OTA; camera.
