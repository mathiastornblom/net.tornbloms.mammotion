/**
 * Parses a read-only schedule response (MctlNav.todev_planjob_set echoed back by the
 * device after a read request — see LubaCommands.buildReadScheduleCommand).
 *
 * Field paths verified by round-trip encode/decode against mctrl_nav.proto's
 * NavPlanJobSet message. The `reserved` byte buffer (enable flag + other settings) is
 * intentionally NOT decoded here — pymammotion's own source notes its exact encoding
 * isn't fully understood, so we surface only the well-understood fields.
 */
export interface ScheduleInfo {
  planId: string;
  planIndex: number;
  totalPlanCount: number;
  taskName: string;
  startTime: string;
  endTime: string;
  /** ISO weekday bitmask or list, as reported by the device (semantics not fully decoded). */
  week: number;
  weeks: number[];
  startDate: string;
  endDate: string;
  bladeHeightMm: number;
  speedMs: number;
  /** NavPlanJobSet.route_spacing (field 21) — the path spacing the user configured for this
   *  task in the official app. This is the stored-task counterpart of the field
   *  buildGenerateRouteCommand sends as NavReqCoverPath.channelWidth; the two messages name
   *  the same concept differently, so don't go looking for a `channelWidth` on this message
   *  (field 7 is `userId`).
   *
   *  Units are the device's own and deliberately not converted: a real report (R9) has a
   *  user running "8 cm" in the official app while a different number takes effect via
   *  Homey, so the wire value's relationship to the displayed centimetres is not yet
   *  established. Read so the generic start path can echo the device's own figure back
   *  instead of a hardcoded default. 0 means the device didn't report one. */
  routeSpacing: number;
}

/** Returns null if the message isn't a schedule read response. */
export function extractSchedule(msg: Record<string, unknown>): ScheduleInfo | null {
  const nav = msg.nav as Record<string, unknown> | undefined;
  const plan = nav?.todevPlanjobSet as Record<string, unknown> | undefined;
  if (!plan) return null;

  return {
    planId: typeof plan.planId === 'string' ? plan.planId : '',
    planIndex: typeof plan.PlanIndex === 'number' ? plan.PlanIndex : 0,
    totalPlanCount: typeof plan.totalPlanNum === 'number' ? plan.totalPlanNum : 0,
    taskName: typeof plan.taskName === 'string' ? plan.taskName : '',
    startTime: typeof plan.startTime === 'string' ? plan.startTime : '',
    endTime: typeof plan.endTime === 'string' ? plan.endTime : '',
    week: typeof plan.week === 'number' ? plan.week : 0,
    weeks: Array.isArray(plan.weeks) ? plan.weeks as number[] : [],
    startDate: typeof plan.startDate === 'string' ? plan.startDate : '',
    endDate: typeof plan.endDate === 'string' ? plan.endDate : '',
    bladeHeightMm: typeof plan.knifeHeight === 'number' ? plan.knifeHeight : 0,
    speedMs: typeof plan.speed === 'number' ? plan.speed : 0,
    routeSpacing: typeof plan.routeSpacing === 'number' ? plan.routeSpacing : 0,
  };
}
