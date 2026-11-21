import type { Booking } from "@/lib/types";

/**
 * "Find a booking" on the staff calendar (Phase I-2b): matches the bookings of the day that are already on
 * screen, by name or phone. It never reads anything: the rows passed in are the ones the calendar loaded for
 * this club's staff (bookings, and names and phones from club_booking_contacts).
 *   - name: the typed text (2 characters or more) anywhere in the customer's or player's name, any case;
 *   - phone: the typed digits (3 or more) anywhere in the phone number, ignoring spaces, + and dashes.
 */
export function matchBookings(rows: readonly Booking[], query: string): Booking[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const byPhone = digits.length >= 3 && /^[\d\s+()-]+$/.test(q);
  return rows.filter((b) => {
    if (byPhone) {
      const phone = (b.contact_phone ?? b.guest_phone ?? "").replace(/\D/g, "");
      return phone.includes(digits);
    }
    if (q.length < 2) return false;
    return [b.guest_name, b.player_name].some((n) => (n ?? "").toLowerCase().includes(q));
  }).sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export type CalendarPrefs = { view: "now" | "grid" | "week" | "list"; sport: string | null };

/** The last view and sport filter used on this club's calendar, in this browser (desktop only). */
export function readPrefs(slug: string): CalendarPrefs | null {
  try {
    const raw = window.localStorage.getItem(`courtbook:calendar:${slug}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CalendarPrefs>;
    if (!p || !["now", "grid", "week", "list"].includes(p.view as string)) return null;
    return { view: p.view as CalendarPrefs["view"], sport: typeof p.sport === "string" && /^[a-z_]+$/.test(p.sport) ? p.sport : null };
  } catch {
    return null;
  }
}

export function writePrefs(slug: string, prefs: CalendarPrefs): void {
  try {
    window.localStorage.setItem(`courtbook:calendar:${slug}`, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode, quota): the calendar simply opens on its defaults */
  }
}
