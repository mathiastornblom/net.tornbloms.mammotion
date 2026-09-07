# Camera Stream Feasibility (Agora → Homey ManagerVideos)

Status: **de-risk step 1 of 2 DONE — auth/entitlement path verified live.** Verdict: **feasible
with heavy caveats, hardware confirmed, biggest remaining unknown is the SDP layer.**
Priority context: `docs/ROADMAP.md` currently lists this as "Phase 7 — skip, high complexity
for uncertain value." This memo revises that: a viable pure-Node path exists in the reference
source, and the auth/entitlement half of it now has live confirmation against a real device.
The remaining risk is entirely in the reverse-engineered Agora signaling/SDP layer (untouched
so far) — see "Next steps to de-risk" for what's left.

## Live verification (2026-07-22)
Hardware blocker resolved: the developer's mower is a **Luba 3**, confirmed by the user to be
camera-equipped. Ported just the two HTTP calls (`fetchStreamToken`, `fetchVideoResource` in
`lib/mammotion/auth/MammotionAuth.ts`) and ran them for real against the account's actual Luba
(`Luba-VAZSPPU6`, EU region) via `scripts/test-camera-token.ts`:
- `fetchVideoResource` → `ok`, 4G budget `totalTime=3600` / `availableTime=3504` (minutes/month).
- `fetchStreamToken` → `ok`, live Agora `appid`, a 183-char channel token, a 32-char license, and
  **3 separate camera tokens** (`cameraId` 1/2/3, ~171 chars each) — this Luba 3 exposes multiple
  camera feeds, not just one FPV lens. `channelName` echoes back the `iotId` we sent.
- Confirms pymammotion's documented request/response contract field-for-field; no guessed shapes
  remain unverified on this half of the pipeline.
- Notable quirk: this device has no `deviceId` in `fetchDeviceRecords`, only `iotId` — passing
  `iotId` as the `deviceId` param worked fine (Mammotion's cloud treats them as interchangeable
  here), consistent with pymammotion's own `iot_id`-as-`deviceId` usage.
- Build (`npm run build`) and full test suite (`npm test`) clean; no lint regressions. Nothing
  committed — changes sit staged for review pending a decision on whether to continue.

This does **not** touch the unverified half: none of `agora_api.py`/`agora_sdp.py`/
`agora_websocket.py` has been ported or exercised yet, so the SDP-compatibility risk below is
still fully open.

## Why this exists
A user asked to view the mower's built-in (FPV) camera in Homey. Homey's `ManagerVideos`
(`this.homey.videos.createVideoWebRTC()` + `device.setCameraVideo()`) can broker a stream if
our app can turn a frontend SDP offer into an SDP answer, or hand back a plain RTSP/RTMP/HLS
URL. This memo determines whether Mammotion's camera can be adapted to that model.

## What was found (verified against reference source)
- **Agora is confirmed.** `pymammotion/http/model/camera_stream.py` defines
  `StreamSubscriptionResponse{appid, token, channelName, uid, cameras[], areaCode, ...}` — a
  textbook Agora RTC channel subscription. Verified in source, not inferred.
- **The token endpoint is callable by us.** `Mammotion-HA` `http.py::get_stream_subscription`
  does `POST {MAMMOTION_API_DOMAIN}/device-server/v1/stream/token` with the same `Bearer`
  access token we already hold after login (payload `{deviceId, mode:0, cameraStates:[...]}`).
  Mammotion is the Agora *customer*; their cloud mints the Agora channel token for us, so we
  need **no Agora account of our own**. Also `GET /device-server/v1/video-resource/{iotId}`
  returns the 4G free-minutes budget.
- **There is NO plain SDP-in/SDP-out endpoint, and no RTSP/RTMP/HLS URL.** Mammotion only
  hands out an Agora channel. To get media you must join that channel over Agora's proprietary
  gateway protocol.
- **The HA integration reverse-engineered Agora's gateway entirely in pure Python** (added
  ~May 2026), no Agora SDK, no native code. Three modules:
  - `agora_api.py` (~800 lines): calls Agora AP hosts `webrtc2-ap-web-{1..6}.agora.io`
    `/api/v2/transpond/webrtc?v=2` to get edge gateway addresses + TURN servers + DTLS
    fingerprints. Crypto is only `hashlib.sha256` (UID-derived TURN password).
  - `agora_sdp.py` (~530 lines): SDP parse/write, browser-offer→ORTC, ORTC→answer.
  - `agora_websocket.py` (~1400 lines): opens `wss://<ip-dashed>.edge.agora.io:<port>`, sends
    `join_v3` (hardcoded to mimic `agoraRTC_N.js` SDK v4.24.3), receives ORTC params, builds
    the answer SDP, then runs subscribe / token-renew / ping / trickle-candidate / FPV
    keepalive / peer-recovery loops.
  - Device side: `pymammotion .../messages/video.py` — `device_agora_join_channel_with_position`
    (proto `SocMul/MulSetVideo`, sent via BLE or cloud MQTT) tells the mower to start
    publishing to the channel; `refresh_fpv` re-arms the encoder every ~3 s on 4G.

## External validation against official Agora docs
Cross-checked the reverse-engineering above against `docs.agora.io` (2026-07-22) rather than
relying only on pymammotion source:
- **Signaling is a separate product**, not RTC channel joining — it's Agora's pub/sub messaging
  API (`/en/api-reference/api-ref/signaling`), unrelated to voice/video. Confirms there is no
  official "plain messaging API" shortcut into an RTC channel.
- **Media Gateway / RTMP Gateway is ingress-only**: "Publish RTMP and SRT streams into Agora RTC
  channels" — pushes external sources in, does not let external RTMP/HLS clients watch a channel.
  Rules out "point Homey's `createVideoRTMP()` at some Agora ingest URL" — wrong direction.
- **Media Push (`/en/realtime-media/media-push`) is the only official egress-to-RTMP/RTMPS
  path**, and it's a RESTful API keyed to the Agora *project's* App ID/App Certificate
  (Customer ID/Secret from Agora Console) — i.e. only whoever owns the Agora project (Mammotion)
  can invoke it. Confirms our source-level finding: not usable by us as a third party unless
  Mammotion's own cloud exposes a wrapper for it (nothing in pymammotion suggests it does — the
  only stream endpoint pymammotion calls returns a raw channel token, not a Media Push URL).
- **No official raw SDP-offer/SDP-answer REST endpoint exists** for RTC channels at all — joining
  is always via an Agora SDK (native or `agora-rtc-sdk-ng` in a browser) speaking Agora's private
  gateway protocol. This matches why HA had to reverse-engineer `agora_websocket.py`/`agora_sdp.py`
  from scratch instead of finding a documented shortcut — there isn't one. It also means the
  reverse-engineered path is inherently unsupported and can break on any Agora-side protocol
  revision, with no official fallback to fall back to.

## Why this maps onto Homey (the key insight)
Our Node code would **never touch media**. It only exchanges JSON-over-WSS signaling and munges
SDP text. The actual WebRTC PeerConnection lives in the Homey frontend (or Homey's WebRTC
proxy), which connects **directly to Agora's edge servers** using the ICE-lite candidates our
answer embeds. That is exactly the broker role `createVideoWebRTC(offerListener)` expects:
`offerSdp in → answerSdp out`. The 4G encoder poke maps to the optional `keepAliveListener`.
No native addon, no `child_process`, no in-app media relay — so it fits the App Store
constraints. Dependencies would be `ws` and `sdp-transform` (both pure JS, small); crypto is
Node built-in.

## What is explicitly NOT viable (and why)
- **The go2rtc/Frigate bridge approach** (HA issue #755): subscribes as audience, pulls the
  RTP media into the process, **transcodes with ffmpeg** to H.264, republishes as RTSP. Rejected
  for Homey — needs a native WebRTC media stack (aiortc/werift) + ffmpeg binary, makes the
  memory-constrained Homey 3s a media relay, and Homey explicitly does not want the app relaying
  media. Do not pursue.
- **Agora Cloud Recording / Media Push (RTMP converter)**: these exist but are authorized with
  Agora *customer* credentials (Mammotion's App Certificate), which we do not and cannot have.
  Not an option for a third party.

## Scope if built (don't undersell it)
Port ~2700 lines of reverse-engineered signaling (agora_api + agora_sdp + agora_websocket) to
strict TS, plus: the two HTTP endpoints into our Mammotion HTTP client; the `SocMul`/`MulSetVideo`/
`MulSetEncode` protobufs (`luba_mul.proto`) into our codec; a device-side join/refresh command on
both BLE and cloud-MQTT transports; and a Homey `createVideoWebRTC` glue layer (offer/keepalive
listeners, `setCameraVideo`, teardown on session close). Touches: `lib/mammotion/http`,
`lib/mammotion/protocol/proto`, `lib/mammotion/commands`, both transports, and `drivers/luba/device.ts`.

## What CANNOT be verified before shipping
- **Homey's offer SDP differs from HA/browser's.** The answer generator has hardcoded assumptions
  (m-line/mid ordering; it deliberately drops the MID header extension because Agora hardcodes
  video at mid=2 while HA's offer has video at mid=1). Homey's frontend/proxy offer may use a
  different layout and break this exact hack. Untestable without a real Homey offer captured.
- **Homey 12.12+ auto WebRTC proxy** re-terminates the connection; unknown whether Homey's proxy
  PeerConnection tolerates Agora's ICE-lite + edge candidates (may need `disableWebRTCProxy: true`,
  which then loses remote/off-LAN viewing).
- **Trickle ICE:** Homey's `offerListener` is single-shot; likely fine because Agora is ICE-lite
  (frontend is controlling, checks the edge candidates in our answer), but unconfirmed.
- **Reference fragility:** even in HA the camera is flaky — open issues #762 ("does not provide
  video stream"), #789 ("no longer working – no stream data"). And the whole thing is pinned to
  Agora SDK v4.24.3 behaviour; Agora can change the private gateway protocol with no notice —
  ongoing maintenance burden, not a build-once feature.
- **Hardware:** need to confirm the developer's own Luba 2 unit actually has camera hardware
  (FPV camera is on AWD / Luba 3 / Yuka / Spino variants; `is_luba1` is excluded in HA). Without
  a camera-equipped unit on the test account, none of this can be verified end-to-end at all.

## Options, ranked
1. **De-risk step 2, then decide (recommended next).** Auth path is now proven; the only way to
   know if the hard part (SDP/signaling compatibility) works is to capture a real Homey offer SDP
   and check it against `agora_sdp.py`'s assumptions — see next steps. Cheap relative to a full
   port, and it's the one unknown that determines whether the rest is worth building at all.
2. **Build now.** Still not recommended — the signaling layer (~2700 lines) is the expensive,
   fragile part, and step 2 above wasn't done yet as of this revision.
3. **Defer.** Reasonable if there's no bandwidth right now; nothing here decays other than Agora
   possibly changing their protocol. Auth-path work already done is not wasted if resumed later.

## Next steps to de-risk
1. ~~Confirm a camera-equipped mower is on the test account.~~ **Done** — Luba 3, confirmed.
2. ~~Port the two HTTP calls and confirm a live token.~~ **Done** — see "Live verification" above.
3. **Capture Homey's actual WebRTC offer SDP** from `createVideoWebRTC` (a throwaway test driver
   with a logging `offerListener` that just dumps the offer and returns a dummy answer) and diff
   its m-line/mid/extension layout against what `agora_sdp.py` assumes (video hardcoded at mid=2,
   MID header extension dropped). **This is now the single biggest unknown** and the natural next
   step given step 2 succeeded.
4. Watch HA issues #762/#789 and pymammotion for whether upstream keeps the Agora path working;
   optionally open a pymammotion discussion asking if anyone has driven the Agora flow from a
   non-browser SDP offer (i.e. how portable the answer generator is).
