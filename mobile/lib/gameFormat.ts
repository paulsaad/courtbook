import { formatInTimeZone } from "date-fns-tz";
import { hhmm, shiftDate } from "@shared/time";
import { fitLabel, rangeLabel } from "@shared/levels";
import { BEIRUT, localDate } from "./gameFilters";
import { sportName } from "./days";
import type { JoinMode, OpenGameRow } from "./gameTypes";

/** Display text for games (docs/m3/04-ux-spec.md §4.3). Display only — never a decision. */

export const NO_COURT = "No court booked through CourtBook"; // P1: wording must never imply a reservation

export type When = { day: string; time: string; a11y: string };

/** "Today" / "Tomorrow" / "Sat 21 Nov", "18:00–19:30", in the club's timezone. */
export function gameWhen(startAt: string, endAt: string | null, tz: string = BEIRUT, now: Date = new Date()): When {
  const date = formatInTimeZone(new Date(startAt), tz, "yyyy-MM-dd");
  const today = localDate(now, tz);
  const day = date === today ? "Today" : date === shiftDate(today, 1) ? "Tomorrow" : formatInTimeZone(new Date(startAt), tz, "EEE d MMM");
  const start = hhmm(startAt, tz);
  const time = endAt ? `${start}–${hhmm(endAt, tz)}` : start;
  const longDay = day === "Today" || day === "Tomorrow" ? `${day}, ${formatInTimeZone(new Date(startAt), tz, "EEEE d MMMM")}` : formatInTimeZone(new Date(startAt), tz, "EEEE d MMMM");
  return { day, time, a11y: endAt ? `${longDay}, ${start} to ${hhmm(endAt, tz)}` : `${longDay}, ${start}` };
}

/** Spots as PlayerSlots counts them: the organiser takes one place (web: "joined+1 / needed+1"). */
export function spots(playersNeeded: number, joined: number) {
  const capacity = playersNeeded + 1;
  const filled = Math.min(joined + 1, capacity);
  const open = capacity - filled;
  return { capacity, filled, open, text: open === 0 ? "Full" : open === 1 ? "1 spot left" : `${open} spots left` };
}

export function joinModeLabel(mode: JoinMode): string {
  return mode === "approval" ? "Ask to join" : "Join straight away";
}

export function courtLabel(courtName: string | null, hasCourt: boolean): string {
  return hasCourt && courtName ? courtName : NO_COURT;
}

/** Everything a board card shows, in reading order, plus one accessibility sentence. */
export function boardCard(row: OpenGameRow, now: Date = new Date(), tz: string = BEIRUT) {
  const when = gameWhen(row.start_at, row.end_at, tz, now);
  const s = spots(row.players_needed, row.joined);
  const court = courtLabel(row.court_name, row.booking_id != null);
  const level = rangeLabel(row.level_min, row.level_max, row.level_legacy);
  const fit = fitLabel(row.my_level, row.level_min, row.level_max);
  const join = joinModeLabel(row.join_mode);
  const place = row.town ? `${row.club_name}, ${row.town}` : row.club_name;
  const a11y = [
    sportName(row.sport), when.a11y, place, court, level, fit.text,
    `${s.filled} of ${s.capacity} players`, s.text, row.join_mode === "approval" ? "asks to join" : "join straight away",
  ].join(", ");
  return { when, spots: s, court, level, fit, join, place, organiser: row.organizer_name, note: row.note, joined: row.i_joined, a11y };
}
