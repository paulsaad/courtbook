import type { Club } from "@/lib/types";

/**
 * Which lengths and times the staff calendar offers. The database decides (staff_book, move_booking,
 * staff_block, the slot trigger); these lists only keep the screen from offering what it would refuse.
 * Rules (Phase 9, 2026-11-11; moves 0066, 2026-11-14; blocks 0076, 2026-11-21):
 *   - a booking, and a move that changes a booking's length: the club's minimum to maximum;
 *   - a move that keeps the booking's current length: always offered, even if the club's limits
 *     changed since the booking was made;
 *   - a block (maintenance, event): a start on the club's grid whose slot has not ended, and any end on
 *     the grid up to closing time or the next booking, hold or block on that court (no length limit).
 * Everything must also end by closing time.
 */

type Limits = Pick<Club, "slot_minutes" | "min_booking_minutes" | "max_booking_minutes">;
/** A taken interval on one court and day, in minutes after club-local midnight: [start, end). */
export type Busy = readonly [number, number];

/** Slot counts for a booking starting at `startMin` (minutes after midnight, club time). */
export function bookingSlotOptions(club: Limits, startMin: number, closeMin: number, currentSlots?: number): number[] {
  const step = club.slot_minutes;
  const out = new Set<number>();
  for (let n = Math.ceil(club.min_booking_minutes / step); n * step <= club.max_booking_minutes; n++) {
    if (n >= 1 && startMin + n * step <= closeMin) out.add(n);
  }
  if (currentSlots && currentSlots >= 1 && startMin + currentSlots * step <= closeMin) out.add(currentSlots);
  return [...out].sort((a, b) => a - b);
}

/** Block starts: grid times (minutes) whose slot is free on this court and has not ended.
 *  `endedBefore`: minutes before which every slot has ended (today: the current minute; a past day:
 *  1440; a future day: -1). */
export function blockStartOptions(club: Pick<Club, "slot_minutes">, openMin: number, closeMin: number, busy: readonly Busy[], endedBefore: number): number[] {
  const out: number[] = [];
  for (let m = openMin; m + club.slot_minutes <= closeMin; m += club.slot_minutes) {
    const end = m + club.slot_minutes;
    if (end <= endedBefore) continue;
    if (busy.some(([s, e]) => s < end && e > m)) continue;
    out.push(m);
  }
  return out;
}

/** Block ends for a block starting at `startMin`: every grid boundary after it, up to closing time or the
 *  start of the next taken interval on that court, whichever comes first. Empty if the start is taken. */
export function blockEndOptions(club: Pick<Club, "slot_minutes">, startMin: number, closeMin: number, busy: readonly Busy[]): number[] {
  if (busy.some(([s, e]) => s <= startMin && e > startMin)) return [];
  const next = busy.filter(([s]) => s > startMin).reduce((m, [s]) => Math.min(m, s), closeMin);
  const limit = Math.min(closeMin, next);
  const out: number[] = [];
  for (let m = startMin + club.slot_minutes; m <= limit; m += club.slot_minutes) out.push(m);
  return out;
}

/** The option to show as chosen: the wish if it is offered, else the fallback if offered, else the first. */
export function pickSlots(options: number[], wish: number, fallback?: number): number | null {
  if (options.includes(wish)) return wish;
  if (fallback !== undefined && options.includes(fallback)) return fallback;
  return options[0] ?? null;
}

/** "HH:mm" for minutes after midnight (1440 → "24:00"). */
export function minToHhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
