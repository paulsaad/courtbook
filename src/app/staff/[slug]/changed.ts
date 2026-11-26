/**
 * F1 (Paul, 26 Nov): two desks must not unknowingly overwrite each other's moves. The move sends the court and time the
 * sheet was opened with; the database refuses with 'booking_changed_elsewhere' if the booking is no longer there (or
 * 'not_confirmed' if it was cancelled meanwhile). The calendar then reads the booking again and says what changed.
 * These refusals are certain (the database answered), so "not moved" is true; a lost answer is R1's case, not this.
 */
import { formatInTimeZone } from "date-fns-tz";
import { parseISO } from "date-fns";
import { ERRORS } from "@/lib/types";
import { hhmm } from "@/lib/time";

export type Position = { court_id: string | null; start_at: string; end_at: string };
export type Current = Position & { status: string };

/** The refusals a move answers when the booking changed after the sheet was opened. */
export const changedElsewhere = (message: string | undefined) => /booking_changed_elsewhere|not_confirmed/.test(message ?? "");

const STATUS_WORDS: Record<string, string> = { cancelled: "was cancelled", no_show: "was marked as a no-show" };

/**
 * What the desk is told. `seen` is what its sheet showed; `now` is the booking as read again (null: could not be read).
 * Returns the sentence and whether the booking can still be moved (the sheet then shows it where it is now).
 */
export function describeChange(seen: Position, now: Current | null, courtName: (id: string | null) => string, tz: string):
  { text: string; stillActive: boolean } {
  if (!now) return { text: `${ERRORS.booking_changed_elsewhere} Check the calendar before moving it again.`, stillActive: false };
  if (now.status !== "confirmed") {
    return { text: `This booking ${STATUS_WORDS[now.status] ?? "is no longer active"} on another screen, so your move was not saved.`, stillActive: false };
  }
  const day = (iso: string) => formatInTimeZone(parseISO(iso), tz, "yyyy-MM-dd");
  const at = (p: Position, withDay: boolean) =>
    `${courtName(p.court_id)}, ${withDay ? formatInTimeZone(parseISO(p.start_at), tz, "EEE d MMM") + " " : ""}${hhmm(p.start_at, tz)}–${hhmm(p.end_at, tz)}`;
  const same = now.court_id === seen.court_id && Date.parse(now.start_at) === Date.parse(seen.start_at) && Date.parse(now.end_at) === Date.parse(seen.end_at);
  if (same) return { text: `${ERRORS.booking_changed_elsewhere} It is back where you opened it; check it before moving it again.`, stillActive: true };
  const otherDay = day(now.start_at) !== day(seen.start_at);
  return {
    text: `This booking was changed on another screen: it is now on ${at(now, otherDay)} (you opened it on ${at(seen, otherDay)}). Your move was not saved. Check it before moving it again.`,
    stillActive: true,
  };
}
