import { formatInTimeZone } from "date-fns-tz";
import { dayBounds, shiftDate } from "@/lib/time";

export type PlayWhen = "today" | "week" | "any";

/**
 * H10 (Session B's round-3 handover): Find a game "Today" meant the next 24 hours, so at 14:19 on a Thursday it listed
 * Friday 10:00. Now, as in the app and the spec (U6): calendar days in the clubs' time zone.
 *  - today: until the coming midnight in Beirut;
 *  - week:  today and the next 6 days (7 calendar days), as the app's toOpenMatchesParams; not Monday–Sunday;
 *  - any:   no end sent, so the server's own default (unchanged).
 */
export function playWindowEnd(when: PlayWhen, now: Date = new Date(), tz = "Asia/Beirut"): string | null {
  if (when === "any") return null;
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  return dayBounds(when === "today" ? today : shiftDate(today, 6), tz).dayEnd;
}
