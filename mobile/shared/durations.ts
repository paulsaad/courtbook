/**
 * Booking lengths a player may choose: shared by the website and the app (copied to mobile/shared/durations.ts;
 * npm run check:shared keeps them equal). The same rule the database enforces when a booking is made: a whole number
 * of the club's grid steps, no shorter than its minimum and no longer than its maximum. Every such length is offered,
 * shortest first — none is left out (PR-9a: the app used to show only the first four).
 */
export type DurationRules = { slotMinutes: number; minMinutes: number; maxMinutes: number };

export function bookingDurations({ slotMinutes, minMinutes, maxMinutes }: DurationRules): number[] {
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) return [];
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)) return [];
  // the first whole grid step at or above the minimum (a minimum is never below one step)
  const first = Math.max(slotMinutes, Math.ceil(minMinutes / slotMinutes) * slotMinutes);
  const out: number[] = [];
  for (let m = first; m <= maxMinutes; m += slotMinutes) out.push(m);
  return out;
}
