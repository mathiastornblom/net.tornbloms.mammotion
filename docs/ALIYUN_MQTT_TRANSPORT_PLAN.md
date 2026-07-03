# Legacy Aliyun IoT — read+write transport implementation plan

Companion to [`ALIYUN_LEGACY_PLAN.md`](./ALIYUN_LEGACY_PLAN.md), which covers the *why*
(two independent Mammotion cloud device systems) and the v2.3.5 read-only diagnostic
probe. That doc's background is not repeated here. This doc is the *how*: turning the
confirmed-working probe into full read+write support for legacy-bound devices.

**Status as of writing:** the probe's read-only handshake is confirmed working against a
real affected account (log ID `b9f2c3ba-6e48-4f64-b34b-73b532078b65`, app v2.3.5):
`bound=1 shareNotifications=2`, device `Luba-MNJR4AS3` / `productKey=a1dCWYFLROK` /
`iotId=BakiVgR9cPgYtfaRuTrv000000`, invisible via the normal Mammotion cloud API. All
three hand-transcribed signing algorithms work end-to-end against Aliyun's real servers.
The zero-live-verification risk flagged in `ALIYUN_LEGACY_PLAN.md` is resolved for the
**read (listing)** path. It is **not yet** resolved for the write (command invoke) or
telemetry (MQTT) paths — see Risks.

## Source verification note

`ALIYUN_LEGACY_PLAN.md` describes reading `mikey0000/pymammotion` at a point where no
`AliyunMQTTTransport` existed yet. That has since landed upstream in a substantially
more mature form than a simple port — the current `pymammotion` has a full `Transport`
ABC (`pymammotion/transport/base.py`), an `AliyunMQTTTransport` concrete class
(`pymammotion/transport/aliyun_mqtt.py`, 660 lines), rate limiting, circuit breakers,
and account-session orchestration (`pymammotion/client.py`, `_setup_aliyun_transport`,
`login_and_initiate_cloud`, `_connect_iot`). Every claim below was verified by fetching
these exact files on 2026-07-03 via `gh api repos/mikey0000/pymammotion/contents/<path>`
— cite the section headers below if re-verifying later, since line numbers will drift as
upstream evolves.

---

## 1. Same driver vs. separate driver — recommendation: same driver, internal flag

**Recommendation: extend the existing `luba` driver with an internal, non-user-facing
transport-kind flag on `DeviceContext`. Do not create a `luba-legacy` driver.**

### Reasoning

- **Precedent already exists and works.** `drivers/luba/device.ts` already runs two
  fundamentally different transports (BLE via `BleTransport`, cloud via `MqttClient`)
  behind one `active_transport` capability and one `transport_preference` setting
  (`device.ts:25-26`, `:140-157`). Users never choose BLE vs. cloud MQTT explicitly at
  pairing time — the device figures it out. A legacy-Aliyun transport is a third
  instance of the exact same pattern: same command surface (start/stop/dock/blade
  height/etc. via `LubaCommands.ts` builders), same protobuf payload
  (`decodeLubaMsg`/`encodeLubaMsg`), different wire transport underneath.
- **Users cannot self-diagnose which system their mower is on**, and pymammotion's own
  `login_and_initiate_cloud` (`client.py:1091-1184`) doesn't force the distinction either
  — a single account can have both `aliyun_devices` and `mammotion_records` populated
  simultaneously (`client.py:1126-1127, 1145, 1181-1182`), and it silently sets up
  whichever transport(s) the discovered device set needs. Forcing a manual "which type of
  mower do you have" choice at Homey pairing time was already explicitly rejected for the
  read-only probe (`ALIYUN_LEGACY_PLAN.md`'s pairing decision) for exactly this reason —
  the same logic applies here, only more so, since write support raises the stakes of
  guessing wrong.
- **A separate driver doubles a known maintenance hazard.** This project has a
  documented, easy-to-forget gotcha: `driver.ts`'s pairing-time `capabilities` array
  (`driver.ts:289-297`) must be hand-kept in sync with `driver.compose.json`'s
  capabilities, because Homey uses the pairing-time array — not the compose manifest —
  to set up a newly paired device (see the comment at `driver.ts:286-288`, and
  project memory's architecture-decisions note on this exact bug class). A second driver
  means a second `driver.compose.json`, a second capabilities array, a second Flow card
  registration block (`driver.ts:42-116`), and a second pairing UI — quadrupling the
  surface area for that drift bug for a distinction the end user doesn't perceive.
- **The runtime behavior differences are transport-internal, not device-model
  differences.** Credential derivation, broker host, topic shape, and envelope format
  differ — but the inputs (mow commands, blade height, telemetry fields) and outputs
  (Homey capabilities, Flow triggers) are identical. This is the same shape of
  difference BLE-vs-cloud already has (BLE uses BluFi framing + GATT characteristics;
  cloud MQTT uses JWT + Aliyun API Gateway REST invoke) and `device.ts` already handles
  it by branching internally rather than via separate drivers.

### What changes structurally

- Add a `transportKind: 'mammotion' | 'aliyun_legacy'` field to `DeviceContext`
  (`lib/mammotion/auth/types.ts:118-127`), set once at pairing time and stored in
  `store.context` exactly like `productKey`/`recordDeviceName` are today. This is the
  legacy-system equivalent of `productKey`+`recordDeviceName` for the modern system —
  it's per-device data resolved at pairing time, not a live transport-selection signal
  (that's what `active_transport` already is).
- `driver.ts`'s `list_devices` handler: when `probeLegacyAliyunDevices` finds bound
  devices (today it only logs and throws `error.legacy_devices_found` —
  `driver.ts:205-215`), build `PairedDeviceResult` entries from
  `LegacyProbeResult.boundDevices` with `transportKind: 'aliyun_legacy'`, reusing the
  *same* `capabilities` array (`driver.ts:289-297`) — legacy devices expose the exact
  same Homey capability set. Same `buildDeviceList`-style mapping, different context
  source (`AliyunAccountDevice` instead of `DeviceRecord`/`MammotionDevice`).
- `device.ts`'s `startTransports()` (`device.ts:145-157`): branch on
  `context.transportKind`. `'mammotion'` devices keep exactly today's BLE+MQTT logic
  unchanged. `'aliyun_legacy'` devices skip `connectMqtt()` (there is no Mammotion JWT
  session for them — `fetchMqttCredentials` would 404/error) and instead call a new
  `connectAliyunLegacy()`, but **BLE stays available unconditionally** — BLE pairing is
  purely local and protocol-identical regardless of which cloud system owns the device,
  so a legacy-bound mower still benefits from BLE-primary/cloud-fallback exactly like
  today.
- `sendRaw()` (`device.ts:443-460`): add a third branch —
  `this.activeTransport === 'aliyun_legacy'` routes through the new Aliyun transport's
  send path instead of `this.mqtt`. `active_transport` capability gains a third enum
  value (`'aliyun_legacy'`) alongside `'ble'`/`'mqtt'`/`'none'` — update
  `driver.compose.json`'s `active_transport` capability options and all locale files.

This is an additive, backward-compatible change: existing `'mammotion'`-flagged devices
(the implicit default via `context.transportKind ?? 'mammotion'`) are untouched.

---

## 2. Write path — reusing `signedGatewayRequest`

### Verified against source

`pymammotion/aliyun/cloud_gateway.py`, `CloudIOTGateway.send_cloud_command` (confirmed
at the file fetched 2026-07-03, method starting around line 847):

```python
async def send_cloud_command(self, iot_id: str, command: bytes) -> str:
    ...
    config = Config(app_key=..., app_secret=..., domain=self._region_response.data.apiGatewayEndpoint, protocol="https")
    client = Client(config)
    request = CommonParams(api_ver="1.0.5", language="en-US", iot_token=self._session_by_authcode_response.data.iotToken)
    message_id = str(uuid.uuid4())
    body = IoTApiRequest(
        id=message_id,
        params={
            "args": {"content": self.converter.printBase64Binary(command)},
            "identifier": "device_protobuf_sync_service",
            "iotId": f"{iot_id}",
        },
        request=request,
        version="1.0",
    )
    response = await client.async_do_request("/thing/service/invoke", "https", "POST", {}, body, runtime_options)
```

This confirms the original hypothesis exactly, with one correction: **`apiVer` is
`"1.0.5"` for the invoke call**, not `1.0.8`/`1.0.9` like the listing calls. Everything
else matches: same `apiGatewayEndpoint` domain, same `IoTApiRequest{id, version, params,
request}` envelope shape, same CA-signature scheme (`Client.async_do_request` in the
`alibabacloud-iot-api-gateway` package delegates to the same `Client.get_signature` that
`getCaSignature()` in `lib/mammotion/aliyun/signing.ts` already ports). This is also
**structurally identical** to what `MqttClient.sendCommand` already does today for the
*modern* Mammotion system (`lib/mammotion/mqtt/MqttClient.ts:234-279`) — same
`{args: {content}, identifier: "device_protobuf_sync_service", iotId}` body shape, just a
different signing scheme and domain.

### Generalizing `signedGatewayRequest`

`signedGatewayRequest` (`AliyunLegacyProbe.ts:65-112`) is currently a private function
scoped to that file. It already has exactly the right shape for reuse — generic
`domain`/`pathname`/`apiVer`/`params`/`iotToken` — no rewrite needed, just:

1. **Extract it** to a new `lib/mammotion/aliyun/gateway.ts` (or similar), exported, so
   both `AliyunLegacyProbe.ts` (read path) and a new sender module (write path) import
   the same implementation instead of duplicating it.
2. **Add a `sendCloudCommand` function** alongside it:
   ```typescript
   export async function sendAliyunCloudCommand(
     region: AliyunRegionResponse, iotToken: string, iotId: string, commandBytes: Buffer,
   ): Promise<AliyunInvokeResponse> {
     return signedGatewayRequest<AliyunInvokeResponse>({
       domain: region.data.apiGatewayEndpoint,
       pathname: '/thing/service/invoke',
       apiVer: '1.0.5',
       params: {
         args: { content: commandBytes.toString('base64') },
         identifier: 'device_protobuf_sync_service',
         iotId,
       },
       iotToken,
     });
   }
   ```
   Add `AliyunInvokeResponse` to `types.ts` (`{code: number; data?: unknown; message?: string}` —
   verify exact shape once a live response is captured; the read-path responses in
   `types.ts` all follow `{code, data}`, this is very likely identical).
3. **No new signing work.** `getCaSignature` is already correct and already
   unit-tested (`scripts/aliyun-signing.test.mjs`, per `ALIYUN_LEGACY_PLAN.md`).

### What this means for command builders

**Fully reusable, zero changes needed:** every function in
`lib/mammotion/commands/LubaCommands.ts` — `buildStartMowCommand`, `buildTaskControlCommand`,
`buildSetBladeHeightCommand`, `buildSetBladeSpeedCommand`, `buildSetHeadlampCommand`,
`buildSetRainProtectionCommand`, `buildReadScheduleCommand`, `buildRequestIotSyncCommand`
— all just produce base64-encoded `LubaMsg` protobuf bytes via `Codec.ts`. They have no
knowledge of which cloud system delivers those bytes. The only integration point is
`device.ts`'s `sendRaw()`, which needs a third branch to route through
`sendAliyunCloudCommand` instead of `this.mqtt.sendCommand`.

---

## 3. Read path — new `AliyunMqttTransport`

### Verified against source

`pymammotion/transport/aliyun_mqtt.py` (660 lines, fetched 2026-07-03) — full analysis:

**Credential derivation** (`AliyunMQTTTransport._build_credentials`, confirmed exact):
```python
timestamp = str(int(time.time()))
client_id = f"{client_id_base}|securemode=2,signmethod=hmacsha1,ext=1,_ss=1,timestamp={timestamp}|"
sign_content = f"clientId{client_id_base}deviceName{device_name}productKey{product_key}timestamp{timestamp}"
password = hmac.new(device_secret.encode(), sign_content.encode(), hashlib.sha1).hexdigest()
```
This matches the original hypothesis exactly — HMAC-SHA1 hex digest, `sign_content`
field order is `clientId`, `deviceName`, `productKey`, `timestamp` (no separators between
label and value, matching the `aepHandle` signing style already ported in
`AliyunLegacyProbe.ts:225-228`). `username = f"{device_name}&{product_key}"`.

**Broker host** (`AliyunMQTTConfig.from_aliyun_credentials`, and confirmed again in
`client.py:1372`, `_setup_aliyun_transport`):
```
host = f"{productKey}.iot-as-mqtt.{region_id}.aliyuncs.com"
```
where `region_id` comes from **`cloud_client.region_response.data.regionId`**
(`client.py:1369`) — i.e. the `regionId` field already present on `AliyunRegionResponse`
(`lib/mammotion/aliyun/types.ts:9`, already fetched by the existing probe's `getRegion()`
step, currently discarded after use — same situation as `deviceSecret`). Port 8883, TLS.
This resolves the "needs confirming" flag in the task brief: the hostname pattern is
correct, and the missing piece was simply which already-fetched field to use for
`region_id`.

**`productKey`/`deviceName`/`deviceSecret` for the MQTT config** come from
`cloud_client.aep_response.data` (`client.py:1368`) — i.e. exactly the `AliyunAepResponse`
the probe's `aepHandle()` step already fetches and currently discards
(`AliyunLegacyProbe.ts:225-242, 324`). This is the fix needed per the task brief: **retain
the `aepHandle()` return value** instead of discarding it.

**Subscribe topics** (`_default_subscribe_topics`, confirmed — 9 topics, base
`/sys/{productKey}/{deviceName}`):
```
/app/down/account/bind_reply
/app/down/thing/event/property/post_reply
/app/down/thing/wifi/status/notify
/app/down/thing/wifi/connect/event/notify
/app/down/_thing/event/notify
/app/down/thing/events
/app/down/thing/status
/app/down/thing/properties
/app/down/thing/model/down_raw
```

**Publish (bind) topic**: `/sys/{productKey}/{deviceName}/app/up/account/bind`, sent once
per connection with body:
```json
{"id": "msgid1", "version": "1.0", "request": {"clientId": "{username}"}, "params": {"iotToken": "{iotToken}"}}
```
This is a connection-establishment handshake message, not something `MqttClient.ts` has
an analog for (the modern Mammotion MQTT transport doesn't need it) — new code.

**Envelope unwrapping** (`_unwrap_envelope`, confirmed) — two shapes attempted in order:
1. Aliyun `thing.events` shape: `parsed.params.value.content` (base64) — the "9 topics"
   subscribe path.
2. Mammotion direct-MQTT shape: `parsed.params.content` (base64) — same shape
   `MqttClient.ts`'s `extractBase64Content` already handles
   (`lib/mammotion/mqtt/MqttClient.ts:207-215`). **This unwrap logic in `MqttClient.ts`
   is reusable as-is** for shape 2; shape 1 (`params.value.content`) is new but trivial —
   one extra property hop.

Decoded bytes are raw `LubaMsg` protobuf — feeds directly into the app's existing
`decodeLubaMsg` (`lib/mammotion/protocol/Codec.ts:100-108`) and
`extractTelemetry` (`lib/mammotion/protocol/TelemetryParser.ts`), unchanged. This
confirms the task brief's point 2 exactly.

**Command sending does NOT go through this MQTT connection** — confirmed by
`AliyunMQTTTransport.send()`/`_invoke()` (lines ~250-283): it calls
`self._cloud_gateway.send_cloud_command(iot_id, payload)`, i.e. delegates to the same
REST invoke call from Section 2, not an MQTT publish. The MQTT connection here is
**receive-only** (telemetry, status, bind-ack) plus one outbound bind message. This
matters for scoping: `AliyunMqttTransport.ts` (the TS port) only needs `mqtt.js`'s
`subscribe`/`publish`(bind only)/`on('message')` — no ongoing publish-per-command path
like `MqttClient.ts` doesn't need either (it also sends commands via REST, not MQTT
publish — see `MqttClient.ts:234-279` vs `:90-159`).

**TLS**: pymammotion loads a bundled `ca.pem` (Aliyun/GlobalSign CA bundle) rather than
trusting the system trust store outright
(`AliyunMQTTTransport.get_ssl_context`, lines ~356-365). Verify whether Node's default
trust store (which the existing `MqttClient.ts` relies on implicitly via `mqtts://` and
no custom `ca` option) already trusts Aliyun's cert chain — if `mqtt.js` connects
without a custom CA, skip vendoring a CA bundle; if not, a `ca.pem` will need to be
fetched from pymammotion's `pymammotion/resources/ca.pem` and bundled (adds a small
static asset, not a new dependency).

### New file: `lib/mammotion/aliyun/AliyunMqttTransport.ts`

Following the existing transport contract shape both `MqttClient.ts` and
`BleTransport.ts` already use (constructor options with `onMessage`/`onStatus`/`log`/
`logError` callbacks, `connect()`/`disconnect()`, an `isConnected` getter) — see
`BleTransport.ts:90-113, 208-226` and `MqttClient.ts:60-133, 281-293` for the pattern to
match:

```typescript
export interface AliyunMqttConfig {
  host: string;          // `${productKey}.iot-as-mqtt.${regionId}.aliyuncs.com`
  clientIdBase: string;  // pymammotion default: `${productKey}&${deviceName}`
  username: string;      // `${deviceName}&${productKey}`
  deviceName: string;
  productKey: string;
  deviceSecret: string;  // from AepResponse, retained (not discarded) from aepHandle()
  iotToken: string;      // from sessionByAuthCode()
}

export class AliyunMqttTransport {
  constructor(opts: {
    iotId: string;
    config: AliyunMqttConfig;
    onMessage: (iotId: string, decoded: Record<string, unknown>) => void;
    onStatus: (iotId: string, online: boolean) => void;
    log: (msg: string) => void;
    logError: (msg: string) => void;
  });
  connect(): void;    // derives fresh HMAC creds, mqtt.connect(), subscribes 9 topics, publishes bind
  disconnect(): void;
  get isConnected(): boolean;
}
```

Internals: mirror `MqttClient.connect()`'s mqtt.js usage
(`lib/mammotion/mqtt/MqttClient.ts:90-133`) — `mqtt.connect(brokerUrl, {clientId,
username, password, reconnectPeriod: 0, ...})`, same pattern of disabling built-in
reconnect because credentials are timestamp-signed and must be freshly re-derived per
attempt (this is *more* true here than for `MqttClient` — the HMAC-SHA1 password embeds
a `timestamp` that Aliyun likely rejects if stale, same reasoning that already justifies
`reconnectPeriod: 0` in the existing code, comment at `MqttClient.ts:86-89`). On close,
re-derive credentials via `_build_credentials()`-equivalent and reconnect — same
reconnect-with-backoff shape as `device.ts`'s `scheduleMqttReconnect()`
(`device.ts:330-340`), reused via a similar `scheduleAliyunReconnect()`.

**Command routing note:** since `send()` on the Python side delegates to the REST invoke
(Section 2), the TS `AliyunMqttTransport` does *not* need a `send()` method at all — keep
sending and receiving as two separate concerns like the Python original does, and have
`device.ts`'s `sendRaw()` call `sendAliyunCloudCommand` directly (Section 2) rather than
routing through the transport object, exactly mirroring pymammotion's own separation
between `CloudIOTGateway.send_cloud_command` and `AliyunMQTTTransport`.

### Session/credential refresh (new requirement, not in the original task brief)

Verified via `CloudIOTGateway.check_or_refresh_session`
(`pymammotion/aliyun/cloud_gateway.py`, lines ~551-654): the `iotToken` from
`session_by_auth_code()` has a real expiry (`iotTokenExpire`) and a `refreshToken` +
`identityId` pair for renewing it via `POST /account/checkOrRefreshSession` (same
CA-signature scheme, `apiVer: "1.0.4"`, body
`{request: {refreshToken, identityId}}`). **This is currently missing from
`lib/mammotion/aliyun/types.ts`** — `AliyunSessionByAuthCodeResponse.data` only has
`{identityId, iotToken, iotTokenExpire}` (`types.ts:44-47`); it needs `refreshToken` and
`refreshTokenExpire` added, both of which the real Aliyun response includes (per
`cloud_gateway.py:640-651`'s field validation, which requires all five: `identityId`,
`refreshTokenExpire`, `iotToken`, `iotTokenExpire`, `refreshToken`).

Without this, a long-running Homey app would need to re-run the full 6-step handshake
(region → connect → oauth → aep → session → list) every time the iotToken expires
instead of a single lightweight refresh call — functionally fine (the probe already
proves the full handshake works) but wasteful and closer to Aliyun's rate limits. Treat
as a should-have for Stage 3, not a blocker for Stage 1/2.

---

## 4. Reusable vs. genuinely new — summary table

| Component | Status |
|---|---|
| `getCaSignature` / `signing.ts` (all 3 schemes) | Reusable as-is, already verified live |
| `signedGatewayRequest` | Reusable, needs extracting from `AliyunLegacyProbe.ts` to a shared module |
| `probeLegacyAliyunDevices` 6-step handshake | Reusable as-is for pairing; needs to also *return* `aepHandle()`'s response instead of discarding it |
| `Codec.ts` (`encodeLubaMsg`/`decodeLubaMsg`) | Reusable as-is, zero changes |
| `LubaCommands.ts` (all command builders) | Reusable as-is, zero changes |
| `TelemetryParser.ts` / `ScheduleParser.ts` | Reusable as-is, zero changes |
| `MqttClient.ts`'s envelope-unwrap logic | Reusable for the `params.content` shape; need to add the `params.value.content` shape |
| CA-signature write call (`/thing/service/invoke`) | New: `sendAliyunCloudCommand`, thin wrapper over `signedGatewayRequest` |
| HMAC-SHA1 MQTT credential derivation | New: `AliyunMqttTransport._buildCredentials`-equivalent |
| Aliyun MQTT bind handshake, 9-topic subscribe, envelope unwrap | New: `AliyunMqttTransport.ts` |
| Session/credential refresh (`checkOrRefreshSession`) | New: needed for any long-running deployment, not just a one-shot probe |
| `device.ts` transport branching | New: `transportKind` flag + third `sendRaw()` branch + third `active_transport` enum value |
| `driver.ts` pairing device-list construction for legacy devices | New: build `PairedDeviceResult[]` from `LegacyProbeResult.boundDevices` instead of just throwing a diagnostic error |

---

## 5. Staged implementation plan

### Stage 0 — Retain what the probe already fetches (prerequisite, small)
- Change `probeLegacyAliyunDevices` to also return the `AepResponse`
  (`{deviceSecret, productKey, deviceName}`) and the `AliyunRegionResponse.data.regionId`
  it already computes, instead of discarding `aepHandle()`'s result
  (`AliyunLegacyProbe.ts:324`).
- Extract `signedGatewayRequest` out to a shared module (`lib/mammotion/aliyun/gateway.ts`).
- Add `refreshToken`/`refreshTokenExpire` fields to `AliyunSessionByAuthCodeResponse` in
  `types.ts` (harmless now, needed by Stage 3).
- **Effort:** small (a few hours). **Risk:** near zero — pure refactor of code already
  proven to work, no new wire behavior.

### Stage 1 — Write path only (start/stop/dock/blade-height over the CA-signature gateway)
- Add `sendAliyunCloudCommand` (Section 2).
- Wire a `transportKind` flag into `DeviceContext`, `driver.ts` pairing (legacy devices
  now become real `PairedDeviceResult`s, not just a diagnostic-error path), and
  `device.ts`'s `sendRaw()` third branch — but **skip telemetry/MQTT entirely for now**.
  A legacy device paired at this stage can receive commands but has no live status
  feedback beyond whatever BLE already provides (if in range) — acceptable as an
  incremental milestone since it's independently testable and ships value (remote
  start/stop/dock) without the larger MQTT transport.
- **Verification without a live device:** none possible beyond static/unit review — the
  CA-signature scheme is already proven live for reads; the same scheme for
  `/thing/service/invoke` is a very small, well-isolated extension. Low risk to ship
  behind the same "best-effort, never blocks pairing" posture as the probe, but **do
  request a live test from the confirmed affected account** before enabling this for
  all users (see Stage 4).
- **Effort:** small–medium (1-2 days). **Risk:** low-medium — the endpoint and body shape
  are read directly from source, not guessed, but zero live verification of a write call
  specifically (reads and writes go through the same signing code path, which reduces
  but doesn't eliminate this risk — Aliyun could plausibly validate/rate-limit writes
  differently than reads).

### Stage 2 — Read path (`AliyunMqttTransport`, telemetry)
- Build `AliyunMqttTransport.ts` per Section 3.
- Wire into `device.ts`: `connectAliyunLegacy()` alongside (not instead of) BLE, feeding
  the same `handleTelemetry`/`handleRawMessage` pipeline `connectMqtt()` already uses.
- Add `'aliyun_legacy'` to the `active_transport` capability enum
  (`driver.compose.json` + all locale files — remember the capabilities-array pairing
  gotcha from Section 1).
- **Verification without a live device:** none — this is the highest-uncertainty piece
  (new MQTT broker, new credential scheme, new envelope format, no unit-testable pure
  function like `getCaSignature` has). Ship behind a conservative fallback: if the
  Aliyun MQTT connection fails, the device should still be usable via BLE and via Stage
  1's write path — never let a broken telemetry connection block command sending.
- **Effort:** medium–large (3-5 days, most of it defensive/retry logic mirroring
  `MqttClient.ts`'s and `BleTransport.ts`'s existing patterns). **Risk:** medium-high —
  the broker host/credential/topic details are read from source with high confidence,
  but this is genuinely new wire protocol with zero live verification.

### Stage 3 — Credential refresh, TLS CA verification, hardening
- Implement `checkOrRefreshSession`-equivalent so long-running sessions don't re-run the
  full 6-step handshake on every `iotToken` expiry.
- Verify whether a custom CA bundle is actually needed for the MQTT TLS handshake (test
  against Node's default trust store first; only vendor `ca.pem` if that fails).
- Add the rate-limit awareness pymammotion has (`_SEND_LIMIT = 600` per 12h,
  `TooManyRequestsException`/429 handling in `send_cloud_command`) — port at least the
  429 backoff, since Homey's poll-driven `requestSync()` pattern could plausibly trip it
  if left unguarded, though this app doesn't poll as aggressively as HA's coordinator.
- **Effort:** small–medium (1-2 days). **Risk:** low — additive robustness on top of an
  already-working path.

### Stage 4 — Live verification (process, not code)
- The diagnostic report confirms a real user has a legacy-bound account. **Reaching out
  to that user (via the community channel the report came through) to ask if they'd be
  willing to test a build with Stage 1 (and later Stage 2) enabled would be extremely
  valuable** — this is the only way to close the write-path and MQTT-path verification
  gap before general release. This is a suggestion, not an assumption: do not build
  Stage 1/2 assuming this access will materialize, and do not block starting Stage 0/1
  on getting a response first.
- If/when live access is available: verify Stage 1 (a single `dock` or `pause` command
  is low-risk and easily reversible) before Stage 2 (telemetry — higher blast radius if
  the envelope-unwrap logic is subtly wrong, though failure mode there is "no data",
  not "wrong data acted upon").

---

## 6. Overall risk assessment

The single biggest remaining unknown is **the write path (`/thing/service/invoke`) and
the entire MQTT read path have zero live-server verification**, unlike the listing calls
which are now proven. Both are read from real, current pymammotion source (not guessed
or transcribed from memory), which is a much stronger basis than what shipped in v2.3.5's
probe — but "read from correct source" and "verified against a live server" are different
confidence levels, and only the latter fully rules out subtle bugs (off-by-one in a
signed field, wrong content-type, a header Aliyun's *invoke* endpoint requires that its
*listing* endpoints don't). The mitigations already threaded through this plan — staging
write before read, keeping BLE always available as a fallback, never letting Aliyun
transport failures block other transports, and prioritizing a live test from the
confirmed affected user — are the right shape of risk reduction given that constraint.
