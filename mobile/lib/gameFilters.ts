import { formatInTimeZone } from "date-fns-tz";
import { dayBounds, shiftDate } from "@shared/time";
import { sportName } from "./days";

/**
 * Find a game board filters → open_matches() parameters (docs/m3/03-journeys.md J1, test plan U6).
 * The filters only choose WHICH open games to ask for; the database decides what is open, visible,
 * and fits a level (open_matches' own rules). Nothing here hides or reveals data the server didn't.
 *
 * Discovery window — intentionally different from the website (accepted 17 Nov 2026):
 *
 *   | Choice           | App (this file)                         | Website /play (unchanged)                      |
 *   | Today            | until the coming Beirut midnight        | now + 24 h                                     |
 *   | This week        | today + the next 6 Beirut days          | now + 7 × 24 h                                 |
 *   | Any time (default) | the next 60 Beirut days               | sends no end, so the server default: now + 14 days |
 *
 * The app follows the approved spec: calendar days in the clubs' time zone (U6), and a horizon equal
 * to the 60-day posting limit (GR-10), so "Any time" can show every game that can be posted. Both
 * clients call the same open_matches and see the same games inside each window; the website is not
 * changed to match. The default choice is "Any time", as on the website.
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
 * The "My level" chip's note. open_matches applies My level per game, using the caller's level for
 * THAT game's sport, and lets through every game of a sport the caller has no level for
 * (`pl.level is null` passes — checked on the local replica, 17 Nov). So:
 *  - one sport chosen, no level for it      → the filter does nothing: say so;
 *  - All sports, no level at all            → the filter does nothing: say so;
 *  - All sports, levels for some sports only → games of those sports are filtered, the rest are
 *    all shown: say which sports are filtered.
 * `activeSports` (optional): the sports on offer; when every one has a level, no note is needed.
 */
export function myLevelNote(f: GameFilters, levels: Record<string, number>, activeSports?: string[]): string | null {
  if (!f.myLevel) return null;
  if (f.sport) return levels[f.sport] == null ? "Set your level to filter by it" : null;
  const rated = Object.keys(levels).sort();
  if (rated.length === 0) return "Set your level to filter by it";
  if (activeSports && activeSports.every((s) => levels[s] != null)) return null;
  const names = rated.map(sportName);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `My level uses your ${list} level${rated.length > 1 ? "s" : ""}. Games in other sports show every level.`;
}

/** "Showing the next 100 games. Narrow the dates to see more." when the server cap was reached. */
export function capNote(rowCount: number): string | null {
  return rowCount >= BOARD_LIMIT ? `Showing the next ${BOARD_LIMIT} games. Narrow the dates to see more.` : null;
}

/** The calendar date of `now` in `tz` ("yyyy-MM-dd"); @shared/time's todayIn has no clock argument. */
export function localDate(now: Date, tz: string = BEIRUT): string {
  return formatInTimeZone(now, tz, "yyyy-MM-dd");
}
