# Wheel-lift / emergency-stop fault — diagnostic test plan

## Why this exists

A user (Anders) reported the mower stopping via its physical emergency-stop/wheel-lift safety
mechanism at least twice during a single outing, resuming after a manual restart, with the
Homey app never reflecting any fault. Investigation so far (see PR history on
`net.tornbloms.mammotion`, and the architect research this plan follows up on) has been
**guessing from opportunistic diagnostic snapshots** — logs submitted after the fact, sometimes
across an app restart, never covering a clean before/during/after window. That approach has
produced one confirmed correction already (a bit change that looked like the fault turned out to
be the blade motor switching on) and no answer yet. This plan replaces ad-hoc guessing with a
small number of deliberate, structured captures designed to actually isolate the signal.

## What we already know (confirmed against pymammotion/Mammotion-HA source, not inferred)

- `sys_status` (the work-mode field, `mower_status`'s source) has **never once changed** during
  any captured stop so far. Mammotion-HA's own `activity` property does map one code —
  `WorkMode.MODE_LOCK(17)` — to `ERROR`, which this app now also recognizes (shipped in
  v2.5.26), but we have **no confirmed evidence yet that a wheel-lift specifically produces
  MODE_LOCK**. It might; it might report through a different channel entirely.
- `rpt_dev_status.sensor_status` has a **confirmed, documented bit layout** (sourced from the
  official Mammotion Android app, per pymammotion's own comments): bits 0–2 `bumper_state`, bits
  9–11 `blade_state` (0=off/1=on), bits 12–14/15–17/18–20/21–23 four ultrasonic sensors. **No
  wheel-lift bit exists in this layout.** The `+512` change we previously flagged as a candidate
  is `blade_state` turning on — a false lead, now closed.
- `rpt_dev_status.self_check_status` has **no interpretation anywhere upstream** — Mammotion-HA
  never reads it. One capture showed a single bit clear ~6s before a resume, but that is
  circumstantial timing, not a confirmed meaning.
- `MctlSys.toapp_err_code` (`SysDevErrCode.errorCode`) — a dedicated one-shot fault-push message
  — has **never fired** in any capture so far.
- A `system_update_buf` error-history buffer exists in the proto and looked promising, but
  re-verification found the specific `buf_id==2` parsing we found is **Spino (pool-cleaner)
  specific** in current pymammotion, not the Luba mower path. The real mower-side mechanism (if
  any) for a persisted fault code is still unidentified.
- **Bumper_state (bits 0–2 of `sensor_status`) is a solved, separate question** — every capture
  so far shows it sitting at `1` (`WARNING`) persistently, never `0` (`OK`). Worth understanding
  on its own regardless of the wheel-lift question (see "Also worth doing" below).

## Why the previous captures didn't resolve this

1. **No clean baseline.** `sensorStatusRaw`/`selfCheckStatusRaw` only appear in a log the first
   time that sub-message is included in a report — with no baseline, a value's *first appearance*
   looks identical to a real change, even when it isn't one.
2. **App restarts between "before" and "during."** Restarting resets the change-gating state
   (`lastSensorStatusRaw` etc. in `device.ts`), so anything logged right after a restart is
   guaranteed to look like a "change" regardless of whether it actually changed.
3. **Auto-recovering stops are short.** Every stop captured so far cleared itself within seconds.
   If the real fault signal requires the mower to persist in a locked/faulted state (e.g.
   `MODE_LOCK`, or a real self-check failure needing an explicit resume), a stop that clears
   itself in under 10 seconds may never produce it at all.
4. **No wall-clock correlation.** We've been inferring "this happened during the stop" purely
   from `speed` dropping to 0 in the log — approximate, not exact.

## Test plan

Run these **without restarting the Homey app between steps** (a restart invalidates the
baseline — see point 2 above). Each scenario below should end with **immediately** submitting a
diagnostic report (Settings → Apps → Mammotion → report a problem) covering that whole window,
with the wall-clock times of your actions written in the free-text "User Message" field — that
free text is the only way I can line log timestamps up with what you actually did.

### Scenario 0 — Baseline (do this first, every time)

Let the mower mow undisturbed for **at least 2 minutes** immediately before you trigger anything.
Note the start/end wall-clock time. This is the "known-good" reference — without it we can't
tell a real change from normal noise.

### Scenario 1 — Sustained wheel-lift

1. Note the exact time, then lift **one** wheel and **hold it up** — don't set it down after a
   few seconds. Aim for **60–90 seconds** minimum, well past whatever auto-recovery window the
   short stops we've captured so far have shown (those cleared in well under 30s).
2. While holding it, note: does the mower beep/flash/display anything? If you have the official
   Mammotion app open at the same time, note the **exact text or code it displays** — this is
   often the single fastest way to identify the fault, independent of anything in our own logs.
3. Set the wheel back down, note the time, and note how long it takes to resume (automatically,
   or does it require a manual button press?).
4. Submit the diagnostic report immediately, with all four timestamps (lift, ~1min mark while
   still lifted, set-down, resume) in the User Message.

### Scenario 2 — Both wheels lifted (only if Scenario 1 shows no change at all)

Some mowers only trigger a hard safety lock with **both** drive wheels off the ground, not one.
Repeat Scenario 1's steps with both wheels lifted simultaneously, held the same 60–90s.

### Scenario 3 — Confirm bumper_state's baseline (piggyback on Scenario 0/1, no extra trip needed)

While already out there, note whether the bumper is making contact with anything during the
baseline period vs. the fault period — we want to know if `bumper_state`'s persistent `1`
(`WARNING`) value is normal-idle or reflects, say, dense grass brushing the bumper constantly.

## What I'll do with each capture

- Diff every logged field (`sys_status`, `sensorStatusRaw`, `selfCheckStatusRaw`, and check for
  any `[error_code]` line) between the Scenario 0 baseline and the fault window, bit-by-bit where
  relevant (not just "did the number change").
- Cross-reference wall-clock times you note against log timestamps precisely, not by eyeballing
  `speed` dips.
- If nothing in our current fields changes even during a 60–90s sustained lift, that's itself a
  real, useful, negative result — it would mean the fault genuinely isn't observable through
  `mctrl_sys.proto`'s `report_info_data` at all, and the mower may be reporting it through a
  message type this app doesn't decode yet (e.g. a different oneof branch, or only visible over
  BLE and not MQTT). That would redirect the investigation rather than dead-end it.

## Also worth doing in parallel (cheaper than another field trip)

- **Check for Mammotion's own published error-code documentation.** pymammotion's HTTP client
  confirms Mammotion's cloud serves a `get_all_error_codes()` table with human-readable
  implications/solutions per code — that table's contents may be discoverable via Mammotion's
  own support site, app store screenshots, or community forum posts, independent of us capturing
  a code ourselves first. I can do a documentation search for this; it's low-cost and might
  shortcut identifying the fault entirely if the wording from your official-app screenshot
  (Scenario 1, step 2) matches something documented.
- **Implement `bumper_state`/`blade_state` extraction now**, separately from the wheel-lift
  question — these two are already confirmed, documented bit fields (unlike `self_check_status`
  or the rest of `sensor_status`), so there's no reason to keep them as raw diagnostic-only
  logging. This is a small, low-risk follow-up I can ship independent of the test plan above.

## Options considered

1. **(This plan) Structured, sequenced field test with an explicit baseline + sustained fault +
   official-app cross-check.** Effort: one outing, ~10 extra minutes. Directly addresses all
   four root causes above. Recommended.
2. **Keep submitting diagnostics opportunistically whenever a stop happens naturally.** Zero
   extra effort, but this is exactly what's failed to resolve it across three attempts already —
   no baseline, no guaranteed sustained window, no wall-clock precision.
3. **Add BLE-level packet logging to capture everything unfiltered, skip the guided test.**
   Would catch more than our current field parsing, but is a much larger implementation effort
   (a raw-capture mode) for uncertain payoff versus just running a deliberate test first — worth
   reconsidering only if Scenario 1/2 come back with genuinely nothing.

## Open questions

- Does the official Mammotion app show anything during the stop that we're not seeing at all in
  our own telemetry? (Scenario 1, step 2 — answerable without any code changes.)
- Is `bumper_state` really stuck at `WARNING` in normal operation, or is that misread? (Scenario
  3 — also answerable without code changes, just observation.)
- If Scenario 1/2 show no field change whatsoever, is the fault visible over BLE but not MQTT, or
  in a LubaMsg oneof branch this app's trimmed envelope doesn't decode at all (see
  `luba_msg.proto`'s comment on which branches are kept)? That would be the next research
  question, not a dead end.
