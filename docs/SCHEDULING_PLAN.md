# Scheduling — analysis & scope decision

Source of truth: [PyMammotion](https://github.com/mikey0000/PyMammotion)
(`pymammotion/mammotion/commands/messages/navigation.py`,
`pymammotion/data/model/hash_list.py::Plan`), analyzed 2026-06-30.

## What scheduling requires on-device

The device stores up to N mowing "plans" (`NavPlanJobSet`, `MctlNav` field 40), each with
~36 fields: start/end time, weekday recurrence (`week`/`weeks`/`day`/`trigger_type`),
blade height, speed, route options, and — critically — `zone_hashs` (references to map
zones) and an 8-byte `reserved` buffer.

`sub_cmd` selects the operation: `1`=create, `2`=read, `3`=delete, `4`=edit.

## Why write (create/edit/delete) is NOT implemented

1. **`reserved` byte semantics are not fully decoded even upstream.** pymammotion's own
   source comment: *"Byte 2 = enable flag (0/1); the other bytes carry settings encoded
   with a +10 offset (exact meaning not fully decoded)"*. Getting this wrong on write
   risks silently-wrong device behaviour (e.g. a schedule that looks created but never
   fires, or fires with wrong settings) that we have no way to detect without owning a
   device and round-tripping against it repeatedly.
2. **`zone_hashs` requires map data we don't have.** The Maps & Zones phase (vendor's
   own roadmap phase 5) hasn't been built. An empty `zone_hashs` list is plausible as
   "whole lawn, no zone selection" but unconfirmed.
3. **Homey already solves the actual user need, today, with zero new risk.** Homey's
   own time-based Flow triggers + our existing `start_mowing`/`pause_mowing`/
   `send_to_dock`/`stop_mowing` action cards give "mow at 09:00 every day" with no new
   code. The only thing on-device scheduling adds is *offline resilience* (the mower
   keeps its schedule if Homey/internet is down) — a real but narrower benefit that
   doesn't justify the risk above without device-in-hand iteration.

## What IS implemented (v1.6.2): read-only schedule inspection

- `LubaCommands.buildReadScheduleCommand` — sends `sub_cmd=2` (read-only, never
  create/edit/delete).
- `ScheduleParser.extractSchedule` — parses the device's echo response into the
  well-understood fields only (times, weekday list, blade height, speed, name). Does
  NOT attempt to decode `reserved`.
- Flow action **"Read mowing schedule"** — diagnostic only, logs the result; not
  surfaced as a capability yet (no Homey UI for "list of N schedules" without building
  a custom multi-value display, which is its own scoping decision).
- Round-trip tested: `npm run test:schedule`.

## Path to write support (future, NOT now)

Would require, in order:
1. A real device with an existing schedule created via the official Mammotion app, to
   capture the raw `reserved` bytes for a known on/off state and reverse them
   confidently (not just trust pymammotion's partial guess).
2. Either the Maps phase (for real `zone_hashs`) or confirmation that an empty list is
   accepted by the firmware as "whole lawn".
3. A `plan_id` generator matching `pymammotion.utility.plan_id.new_mower_plan_id`
   (21-character ID format) — not yet ported.
4. Multiple real-device write/read-back cycles to confirm round-trip fidelity before
   trusting it in front of a user.
