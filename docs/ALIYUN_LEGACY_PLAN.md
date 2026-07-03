# Legacy Aliyun IoT Link Platform — investigation & diagnostic probe

## Why this exists

Three community reports (Anders_Gregow, Tomas_Severa, and follow-up diagnostic reports from
Anders_Gregow's own account) showed pairing finding zero devices — `owned=0 records=0
total=0 msg="Request success"` — for a correctly-configured shared account with **two mowers
confirmed visible in the Mammotion Android app**. v2.3.3/v2.3.4 fixed a real gap (this app
never confirmed pending share invitations via `POST /user-server/v1/share/device/page` +
`/confirm`), but that fix alone did not resolve this specific case: the probe it added found
zero pending shares in that system too.

Reading `mikey0000/pymammotion`'s `client.py` revealed why: Mammotion runs **two entirely
separate, parallel cloud device systems**:

- **The one this app implements** (`lib/mammotion/auth/MammotionAuth.ts`) — Mammotion's own
  newer REST API (`domestic.mammotion.com`, JWT-based, plain JSON over HTTPS). pymammotion
  calls this the **post-2025 device** path.
- **A legacy system built directly on Alibaba Cloud IoT Link Platform** — `api.link.aliyun.com`
  and friends, using Alibaba's own signed-request scheme (not Mammotion's). pymammotion calls
  this the **pre-2025 device** path (`pymammotion/aliyun/cloud_gateway.py`,
  `pymammotion/aliyun/client.py`).

A device bound only through the legacy path is fully visible and controllable in the mobile
app (which supports both systems) while being **completely invisible** to this app, which
only ever queries the newer system. This is the leading hypothesis for the affected users'
reports.

## What was built (v2.3.5) — diagnostic probe only

`lib/mammotion/aliyun/AliyunLegacyProbe.ts` implements the **read-only** subset of the legacy
handshake, mirroring pymammotion's `Client._connect_iot()` exactly:

1. `get_region(countryCode)` → `POST api.link.aliyun.com/living/account/region/get`
2. `connect()` → `POST sdk.openaccount.aliyun.com/api/prd/connect.json` (bespoke signing)
3. `login_by_oauth(countryCode)` → `POST {oaApiGatewayEndpoint}/api/prd/loginbyoauth.json` (bespoke signing)
4. `aep_handle()` → `POST {apiGatewayEndpoint}/app/aepauth/handle`
5. `session_by_auth_code()` → `POST {apiGatewayEndpoint}/account/createSessionByAuthCode` — produces the `iotToken`
6. `list_binding_by_account()` → `POST {apiGatewayEndpoint}/uc/listBindingByAccount` — the actual device list
   (plus `get_shared_notice_list()` as a secondary check)

It is wired into `drivers/luba/driver.ts`'s pairing `list_devices` handler as a **silent
fallback**, only attempted when the normal device list comes back empty. It is deliberately:

- **Read-only** — no `confirm_share` / state-changing calls at all.
- **Best-effort** — any failure is caught and logged; pairing falls through to the existing
  "no devices found" message unchanged. A bug in this probe can never break normal pairing.
- **Diagnostic, not functional** — if it finds devices, the user sees a clear message
  (`error.legacy_devices_found`, all 13 languages) explaining this is a known limitation
  being worked on, NOT a working pairing path. No Aliyun MQTT transport exists yet.

## Signing schemes — three distinct algorithms, ported by reading Python source

There is no vendored pymammotion in this repo and no live legacy-bound test account —
everything below was transcribed from `pymammotion/aliyun/cloud_gateway.py` +
`pymammotion/aliyun/client.py` (GitHub, `gh api search/code` + `contents/*`) and the
`alibabacloud-apigateway-util` / `alibabacloud-iot-api-gateway` PyPI packages those files
depend on. **Unverified against a real server.** If this needs debugging later, re-fetch
those exact files rather than trusting memory — this doc, not the Python source, is the
thing likely to have transcription errors.

1. **Alibaba Cloud API Gateway "CA signature"** (`lib/mammotion/aliyun/signing.ts`,
   `getCaSignature`) — used for steps 1, 4, 5, 6 above. HMAC-SHA256 over a canonical
   `METHOD\nAccept\nContent-MD5\nContent-Type\nDate\n{sorted non-standard headers}\n{url}`
   string. Ported from `alibabacloud_apigateway_util.client.Client.get_signature` — this one
   has decent unit-test coverage (`scripts/aliyun-signing.test.mjs`) since it's fully
   deterministic and self-checkable without a live server.
2. **`connect()`'s bespoke signing** — same HMAC-SHA256 family but a different, hand-rolled
   string-to-sign specific to that one hardcoded endpoint (`sdk.openaccount.aliyun.com`), no
   `content-md5` slot, params passed via query string not body.
3. **`login_by_oauth()`'s bespoke signing** — a third variant: form-urlencoded body, but the
   string-to-sign still appends the form data to the URL as if it were a query string (this
   looks like a bug in the *original* Android app/pymammotion, not something to "fix" —
   replicate it exactly).
4. **`aep_handle()`'s payload signing** — separate from all of the above: HMAC-SHA1 hex digest
   over `appKey{key}clientId{id}deviceSn{sn}timestamp{ts}`, signing the *body content*, not
   the HTTP request.

## Explicitly NOT built yet — if this probe confirms the hypothesis

Finding devices via this probe does **not** mean they can be paired. Actually controlling a
legacy-bound device needs, at minimum:

- `AliyunMQTTTransport` (`pymammotion/transport/aliyun_mqtt.py`) — a device-secret-HMAC-signed
  MQTT connection to a *different* broker with a split pub/sub topic model
  (`/sys/{productKey}/{deviceName}/app/down/...`), separate from `MammotionMqtt`.
- `confirm_share` (legacy variant, `/uc/confirmShare`) if any found devices are pending shares
  rather than already-bound.
- Wiring a second transport option into `drivers/luba/device.ts`'s transport selection,
  alongside the existing BLE/cloud-MQTT logic.

Good news: the actual device payload once received is the **same protobuf `LubaMsg`** this
app already decodes (`Codec.ts`, `LubaCommands.ts` builders are reusable as-is) — only the
transport/auth/topic layer differs. This is real but bounded additional work, not a second
protocol to reverse-engineer from scratch.

## Next step

Wait for a diagnostic report from an affected user on v2.3.5+. Grep for
`probeLegacyAliyunDevices` / `legacy Aliyun probe` in the log:

- **Probe finds bound devices or share notifications** → hypothesis confirmed, scope and
  build the `AliyunMQTTTransport` + wire it into `device.ts` (real, non-trivial effort —
  align with the maintainer before starting, this is a bigger feature than anything else in
  this bug chase so far).
- **Probe fails (signing error, network error) with no clear signal** → the transcribed
  signing algorithms likely have a bug; re-verify against the Python source step by step, or
  consider asking the affected user for a one-time network capture after all (their choice,
  not a requirement) to get a known-good reference to diff against.
- **Probe succeeds but finds nothing either** → hypothesis is wrong; the real root cause is
  still unknown and needs fresh investigation (e.g. region mismatch on the *primary* system's
  JWT, an account-linking issue specific to this user, or something not yet considered).
