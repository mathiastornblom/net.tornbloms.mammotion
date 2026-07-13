# LED Ring status feedback — superseded

**Correction (2026-07-13):** the original version of this plan assumed apps can
programmatically drive the LED ring via `this.homey.ledring.createAnimation()` /
`createSystemAnimation()` on any hardware, gated only by runtime feature-detection. That's
wrong for current hardware. Per the maintainer (who checked Homey's actual docs for current
models):

- That direct animation API only works on Homey Pro **Early 2019** and older.
- On Homey Pro **Early 2023** and **2026**, the LED ring can only be controlled via Homey's
  own built-in **"Then → LED ring"** Flow action cards:
  - Enable Screensaver
  - Enable a pulse animation (any color, defined duration)
  - Enable a loading animation (any color, defined duration)
  - Disable LED ring
- These are system-owned Flow cards. A third-party app cannot invoke them from code — only a
  user-built Flow can use them (Homey has no API for one app to programmatically fire
  another app's/the system's Flow action card outside a Flow the user assembled).

## What this means

There is no app code to write. The feature the maintainer wants — mower error / mowing /
charging reflected on the LED ring — is already fully buildable by any user today, using
Flows they create themselves:

| Condition | Existing trigger card (already shipped) |
|---|---|
| Error / fault | `mower_error` — "Mower reported an error" |
| Started mowing | `mower_started_mowing` — "Mower started mowing" |
| Docked / charging | `mower_docked` — "Mower docked" (fires for both `docked` and `charging` status) |
| Any status change (for a reset/"else" branch) | `mower_status_changed` — carries the new status as a token |

A user wires e.g. *When "Mower reported an error" → Then "LED ring: Enable pulse animation"
(red)*, and similarly for mowing (green) and docked/charging (blue), with a status-changed +
logic condition to disable the ring again once back to idle.

## Recommendation

No new permission, settings, or module. Optionally worth doing instead: a short
community-forum post or README/FAQ section showing users exactly how to wire this (many
won't know "Then → LED ring" exists). Not scheduled — offer if the maintainer wants it.
