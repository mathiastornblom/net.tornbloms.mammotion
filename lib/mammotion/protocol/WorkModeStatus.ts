'use strict';

/** The mower_status capability only has these 6 values — see
 *  .homeycompose/capabilities/mower_status.json. */
export type MowerStatus = 'idle' | 'mowing' | 'returning' | 'charging' | 'paused' | 'error';

/** Maps raw work mode integers (+ charge_state) to Homey mower_status enum values.
 *
 *  MODE_READY (11) is ambiguous on its own — sitting idle unplugged and sitting docked and
 *  charging both report it. Mammotion-HA's own state logic (lawn_mower.py's `activity`
 *  property) resolves this by also checking `charge_state`: MODE_READY + chargeState !== 0
 *  is DOCKED (real user report, 2026-07-05 — a mower docking never transitioned to
 *  'charging' and mower_docked never fired).
 *
 *  Beyond that one case, this covers the full WorkMode enum (see lib/mammotion/
 *  constants.ts's WORK_MODE) — a prior version only recognized 8 of ~24 known codes and
 *  bucketed everything else (MODE_INITIALIZATION, MODE_ONLINE, boundary/obstacle-drawing UI
 *  modes, etc.) into 'idle', which — combined with onoff previously being tied to
 *  `status === 'mowing'` — caused spurious onoff flips whenever the mower briefly passed
 *  through one of those unmapped codes mid-job (a real user's diagnostic report of 20-30
 *  false "turned off" notifications overnight, 2026-07-05). mower_status only has 6 values
 *  (idle/mowing/returning/charging/paused/error), so several distinct WorkMode codes
 *  necessarily collapse into the same Homey status; onoff no longer depends on this mapping
 *  at all (see MOWING_ACTIVE_WORK_MODES in constants.ts) specifically to avoid that
 *  collapsing causing further onoff noise. */
export function workModeToStatus(mode: number, chargeState: number | null): MowerStatus {
  if (mode === 11) return chargeState ? 'charging' : 'idle';
  switch (mode) {
    case 13: // MODE_WORKING
    case 20: // MODE_MANUAL_MOWING
      return 'mowing';
    case 14: // MODE_RETURNING
      return 'returning';
    case 15: // MODE_CHARGING
      return 'charging';
    case 19: // MODE_PAUSE
    case 39: // MODE_CHARGING_PAUSE — pymammotion classifies this as an active-job pause,
      // not real charging (see MOWING_ACTIVE_WORK_MODES's header comment), so it's grouped
      // with MODE_PAUSE rather than MODE_CHARGING here too.
      return 'paused';
    case 23: // MODE_OTA_UPGRADE_FAIL
    case 37: // MODE_LOCATION_ERROR
    case 38: // MODE_BOUNDARY_JUMP
      return 'error';
    // Everything else — MODE_NOT_ACTIVE/ONLINE/OFFLINE/POWER_OFF/DISABLE/INITIALIZATION/
    // UPDATING/LOCK/UPDATE_SUCCESS and the mobile-app-only boundary/obstacle/channel/
    // eraser-drawing UI modes — has no better Homey status than 'idle'.
    default: return 'idle';
  }
}

/** Whether a raw work-mode integer represents an error/fault state — kept in sync with
 *  workModeToStatus()'s 'error' cases above (previously missing mode 38, inconsistent with
 *  the status switch which did classify it separately). */
export function isErrorMode(mode: number): boolean {
  return mode === 23 || mode === 37 || mode === 38;
}
