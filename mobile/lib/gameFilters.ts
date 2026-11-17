import { formatInTimeZone } from "date-fns-tz";
import { dayBounds, shiftDate } from "@shared/time";

/**
 * Find a game board filters → open_matches() parameters (docs/m3/03-journeys.md J1, test plan U6).
 * The filters only choose WHICH open games to ask for; the database decides what is open, visible,
 * and fits a level (open_matches' own rules). Nothing here hides or reveals data the server didn't.
 */

export const BEIRUT = "Asia/Beirut";
/** open_matches caps at 100 server-side; asking for the cap means the board can say "showing 100". */
export const BOARD_LIMIT = 100;
/** "Any time" looks this far ahead — the posting horizon of game rule GR-10 (S10). */
export const ANY_TIME_DAYS = 60;

export type When = "today" | "week" | "any";
export type GameFilters = {
  sport: string | null;
  when: When;
  /** "My level" chip: asks the server for games whose range includes the caller's level. */
  myLevel: boolean;
  governorate: string | null;
  district: string | null;
};

export const DEFAULT_FILTERS: GameFilters = { sport: null, when: "any", myLevel: false, governorate: null, district: null };

export type OpenMatchesParams = {
  p_sport: string | null; p_fit: "mine" | null; p_from: string | null; p_to: string;
  p_governorate: string | null; p_district: string | null; p_limit: number;
};

/**
 * Date windows end at a Beirut midnight, not "now + 24 h":
 *  - today: until the end of today in Beirut;
 *  - week:  today and the next 6 days (7 Beirut calendar days);
 *  - any:   the next ANY_TIME_DAYS Beirut days.
 * p_from stays null so the server applies its own "not started" rule (start_at > now()).
 */
export function toOpenMatchesParams(f: GameFilters, now: Date = new Date(), tz: string = BEIRUT): OpenMatchesParams {
  const today = localDate(now, tz);
  const lastDay = f.when === "today" ? today : f.when === "week" ? shiftDate(today, 6) : shiftDate(today, ANY_TIME_DAYS - 1);
  return {
    p_sport: f.sport,
    p_fit: f.myLevel ? "mine" : null,
    p_from: null,
    p_to: dayBounds(lastDay, tz).dayEnd,
    p_governorate: f.district ? null : f.governorate,
    p_district: f.district,
    p_limit: BOARD_LIMIT,
  };
}

/** How many filters differ from the defaults ("Filters · 2"). */
export function activeFilterCount(f: GameFilters): number {
  let n = 0;
  if (f.sport) n++;
  if (f.when !== DEFAULT_FILTERS.when) n++;
  if (f.myLevel) n++;
  if (f.governorate || f.district) n++;
  return n;
}

/**
 * The "My level" chip's note. With no level for the chosen sport the server returns every level
 * (open_matches: `pl.level is null` passes), so the chip must say so rather than look broken.
 */
export function myLevelNote(f: GameFilters, levels: Record<string, number>): string | null {
  if (!f.myLevel) return null;
  if (f.sport && levels[f.sport] == null) return "Set your level to filter by it";
  if (!f.sport && Object.keys(levels).length === 0) return "Set your level to filter by it";
  return null;
}

/** "Showing the next 100 games. Narrow the dates to see more." when the server cap was reached. */
export function capNote(rowCount: number): string | null {
  return rowCount >= BOARD_LIMIT ? `Showing the next ${BOARD_LIMIT} games. Narrow the dates to see more.` : null;
}

/** The calendar date of `now` in `tz` ("yyyy-MM-dd"); @shared/time's todayIn has no clock argument. */
export function localDate(now: Date, tz: string = BEIRUT): string {
  return formatInTimeZone(now, tz, "yyyy-MM-dd");
}
