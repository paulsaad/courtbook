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

export function sportName(code: string): string {
  return code === "other" ? "Other" : code[0].toUpperCase() + code.slice(1);
}
