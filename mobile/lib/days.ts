import { shiftDate, todayIn } from "@shared/time";
import type { Day } from "../components/DateStrip";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Today and the next `count - 1` days in the club timezone, as date-strip entries. */
export function bookingDays(tz: string, count = 15): Day[] {
  const today = todayIn(tz);
  return Array.from({ length: count }, (_, i) => {
    const key = shiftDate(today, i);
    const d = new Date(`${key}T12:00:00Z`);
    const wd = WD[d.getUTCDay()];
    return { key, weekday: i === 0 ? "Today" : wd, day: String(d.getUTCDate()), a11y: `${i === 0 ? "Today, " : ""}${wd} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}` };
  });
}

export function shortDate(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()].slice(0, 3)}`;
}

/** A readable name from a sport code ("table_tennis" → "Table tennis"). The catalogue's own name (lib/sports.ts) wins
 *  where it is loaded; this is the fallback for a code the app has not seen yet (sports are admin-managed). */
export function sportName(code: string): string {
  if (!code) return "Other";
  if (code === "other") return "Other";
  const words = code.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}
