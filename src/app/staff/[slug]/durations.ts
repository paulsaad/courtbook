import type { Club } from "@/lib/types";

/**
 * Which lengths the staff calendar offers, in grid slots. The database decides (staff_book,
 * move_booking, the slot trigger); these lists only keep the screen from offering what it would
 * refuse. Rules (Phase 9, 2026-11-11; moves 0066, 2026-11-14):
 *   - a booking, and a move that changes a booking's length: the club's minimum to maximum;
 *   - a move that keeps the booking's current length: always offered, even if the club's limits
 *     changed since the booking was made;
 *   - a block (maintenance, event): any whole number of slots, up to BLOCK_MAX_MINUTES.
 * Everything must also end by closing time.
 */
export const BLOCK_MAX_MINUTES = 240;

type Limits = Pick<Club, "slot_minutes" | "min_booking_minutes" | "max_booking_minutes">;

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

/** Slot counts for a block starting at `startMin`. Independent of the booking limits. */
export function blockSlotOptions(club: Pick<Club, "slot_minutes">, startMin: number, closeMin: number): number[] {
  const out: number[] = [];
  for (let n = 1; n * club.slot_minutes <= BLOCK_MAX_MINUTES && startMin + n * club.slot_minutes <= closeMin; n++) out.push(n);
  return out;
}

/** The option to show as chosen: the wish if it is offered, else the fallback if offered, else the first. */
export function pickSlots(options: number[], wish: number, fallback?: number): number | null {
  if (options.includes(wish)) return wish;
  if (fallback !== undefined && options.includes(fallback)) return fallback;
  return options[0] ?? null;
}
