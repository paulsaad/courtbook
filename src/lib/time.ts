import { addMinutes, format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** "2026-11-09" + "09:30" in a club's timezone → UTC Date. "24:00" means midnight at the end of that day. */
export function clubLocalToUtc(date: string, time: string, tz: string): Date {
  if (time.startsWith("24:")) return fromZonedTime(`${shiftDate(date, 1)}T00:00:00`, tz);
  return fromZonedTime(`${date}T${time.length === 5 ? time + ":00" : time}`, tz);
}

/** [start, end) of a local calendar day as UTC ISO strings; end is the next local midnight (DST-safe). */
export function dayBounds(date: string, tz: string): { dayStart: string; dayEnd: string } {
  return {
    dayStart: fromZonedTime(`${date}T00:00:00`, tz).toISOString(),
    dayEnd: fromZonedTime(`${shiftDate(date, 1)}T00:00:00`, tz).toISOString(),
  };
}

/** UTC instant → "HH:mm" in the club's timezone */
export function hhmm(d: Date | string, tz: string): string {
  return formatInTimeZone(typeof d === "string" ? parseISO(d) : d, tz, "HH:mm");
}

/** Today's date in the club's timezone, "yyyy-MM-dd" */
export function todayIn(tz: string): string {
  return formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
}

export function shiftDate(date: string, days: number): string {
  const d = parseISO(date);
  d.setDate(d.getDate() + days);
  return format(d, "yyyy-MM-dd");
}

export function prettyDate(date: string): string {
  return format(parseISO(date), "EEE d MMM");
}

/** Slot start times "HH:mm" from open to close by slotMinutes */
export function slotTimes(open: string, close: string, slotMinutes: number): string[] {
  const base = parseISO(`2000-01-01T${open.slice(0, 5)}:00`);
  const closeMin = close === "24:00:00" || close === "24:00" ? 1440 : toMin(close);
  const out: string[] = [];
  for (let m = toMin(open); m + slotMinutes <= closeMin; m += slotMinutes) {
    out.push(format(addMinutes(base, m - toMin(open)), "HH:mm"));
  }
  return out;
}

export function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** The Monday of the week containing `date` (ISO yyyy-mm-dd). */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDate(date, -((dow + 6) % 7));
}

/** Current time in ms. Kept out of components so React's purity lint does not flag server renders. */
export function nowMs(): number {
  return Date.now();
}
