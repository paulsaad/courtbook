import { QueryClient } from "@tanstack/react-query";
import { fromZonedTime } from "date-fns-tz";
import { shiftDate } from "@shared/time";
import { gameKeys } from "./games";
import { DEFAULT_FILTERS, localDate } from "./gameFilters";
import type { GameDetail, OpenGameRow, ParticipantRow } from "./gameTypes";

/**
 * EMULATOR SCREENSHOTS ONLY (test builds, EXPO_PUBLIC_E2E=1; see app/e2e-games.tsx). The approved
 * Stitch sample data (pack 2), so the real Find a game and Game screens can be photographed in every
 * state and compared with the exports without writing games to staging. Never shown in a release
 * build: the route redirects to Home unless the build is the emulator test build.
 */
export const E2E_SCREENS = process.env.EXPO_PUBLIC_E2E === "1";

const TZ = "Asia/Beirut";
/** Beirut wall-clock time `hh:mm` on today + `days`, as an ISO instant. */
function at(days: number, hhmm: string): string {
  return fromZonedTime(`${shiftDate(localDate(new Date(), TZ), days)}T${hhmm}:00`, TZ).toISOString();
}
const plus = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60_000).toISOString();

const card = (o: Partial<OpenGameRow> & { match_id: string }): OpenGameRow => ({
  club_id: "e2e-club", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", town: "Batroun", sport: "padel",
  start_at: at(2, "18:00"), end_at: plus(at(2, "18:00"), 90), level_min: 4, level_max: 6, level_legacy: false, my_level: 5,
  players_needed: 3, joined: 1, note: null, organizer_name: "Rami", join_mode: "approval", i_joined: false, booking_id: "e2e-b", court_name: "Court 2",
  ...o,
});

export const E2E_BOARD: OpenGameRow[] = [
  card({ match_id: "e2e-1", note: "Friendly doubles, bring balls" }),
  card({ match_id: "e2e-2", sport: "tennis", start_at: at(2, "08:00"), end_at: plus(at(2, "08:00"), 90), level_min: null, level_max: null, my_level: null, players_needed: 1, joined: 0, organizer_name: "Maya", join_mode: "open", court_name: "Court 1" }),
  card({ match_id: "e2e-3", sport: "football", club_name: "Tripoli Olympic Sports Complex Arena", town: "Tripoli", start_at: at(3, "20:00"), end_at: plus(at(3, "20:00"), 60), level_min: 6, level_max: 9, players_needed: 9, joined: 6, organizer_name: "Karim", join_mode: "open", booking_id: null, court_name: null, note: "5-a-side, bibs provided" }),
  card({ match_id: "e2e-4", start_at: at(4, "19:00"), end_at: plus(at(4, "19:00"), 90), level_min: 1, level_max: 3, joined: 2, organizer_name: "Joe", note: "Relaxed game", court_name: "Court 1" }),
  card({ match_id: "e2e-5", sport: "basketball", start_at: at(5, "17:00"), end_at: plus(at(5, "17:00"), 90), level_min: 3, level_max: 7, my_level: null, players_needed: 7, joined: 3, organizer_name: "Nadim", join_mode: "open", court_name: "Court 3" }),
];

const detail = (o: Partial<GameDetail>): GameDetail => ({
  match_id: "e2e-g", club_id: "e2e-club", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: TZ, town: "Batroun",
  sport: "padel", start_at: at(2, "18:00"), end_at: plus(at(2, "18:00"), 90), level_min: 4, level_max: 6, level_legacy: false, my_level: 5,
  players_needed: 3, joined: 1, pending: null, status: "open", closed_reason: null, court_lost: false, note: "Friendly doubles, bring balls",
  join_mode: "approval", organizer_id: null, organizer_name: "Rami", my_status: null, i_organize: false,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false, ...o,
});
const p = (id: string, name: string, level: number, status: "accepted" | "pending", org = false): ParticipantRow =>
  ({ profile_id: id, name, level, level_legacy: null, is_organizer: org, status });

/** States A–E of the exports, then the other statuses. `me` is the signed-in tester (for "You"). */
export function e2eDetail(state: string, me: string): { d: GameDetail; people: ParticipantRow[] } {
  const roster = [p("e2e-o", "Rami", 5, "accepted", true), p(me, "Adam", 4, "accepted")];
  const requests = [p("e2e-b", "Bana", 5, "pending"), p("e2e-j", "Joe", 6, "pending")];
  switch (state) {
    case "B": return { d: detail({ my_status: "pending" }), people: [] };
    case "C": return { d: detail({ my_status: "accepted" }), people: roster };
    case "D": return { d: detail({ i_organize: true, pending: 2 }), people: [p(me, "Rami", 5, "accepted", true), p("e2e-a", "Adam", 4, "accepted"), ...requests] };
    case "E": return { d: detail({ i_organize: true, pending: 0, status: "closed", closed_reason: "no_court", court_lost: true, has_court: false, court_name: null }), people: [p(me, "Rami", 5, "accepted", true), p("e2e-k", "Karim", 6, "accepted")] };
    case "playing": return { d: detail({ my_status: "accepted", start_at: plus(new Date().toISOString(), -30), end_at: plus(new Date().toISOString(), 60), started: true }), people: roster };
    case "played": return { d: detail({ my_status: "accepted", start_at: plus(new Date().toISOString(), -180), end_at: plus(new Date().toISOString(), -90), started: true, finished: true }), people: roster };
    case "private": return { d: detail({ my_status: "accepted", status: "closed", closed_reason: "organizer" }), people: roster };
    case "full": return { d: detail({ joined: 3, status: "closed", closed_reason: "full", join_mode: "open" }), people: [] };
    case "cancelled": return { d: detail({ my_status: "accepted", status: "cancelled" }), people: roster };
    case "nocourt": return { d: detail({ has_court: false, court_name: null, my_level: 8 }), people: [] };
    default: return { d: detail({}), people: [] }; // A
  }
}

/** A query client already holding the sample answers, fresh for a year: the screens make no call. */
export function e2eClient(view: string, state: string, me: string): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fresh = { updatedAt: Date.now() + 365 * 86_400_000 };
  if (view === "board") {
    qc.setQueryData(gameKeys.board(DEFAULT_FILTERS), E2E_BOARD, fresh);
    qc.setQueryData(gameKeys.myLevels, { padel: 5, football: 5 }, fresh);
    qc.setQueryData(gameKeys.areas, [], fresh);
  } else {
    const { d, people } = e2eDetail(state, me);
    qc.setQueryData(gameKeys.detail("e2e-g"), d, fresh);
    qc.setQueryData(gameKeys.people("e2e-g"), people, fresh);
  }
  return qc;
}
