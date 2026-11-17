/**
 * Row shapes of the database functions Find a Game reads (docs/m3/05-architecture.md §5.2).
 * They mirror the functions' `returns table (...)` exactly; the database decides every value.
 */

export type MatchStatus = "open" | "closed" | "cancelled";
/** `no_court` is written only once migration 0068 is in place (game rule GR-9). */
export type ClosedReason = "full" | "organizer" | "no_court" | null;
export type JoinMode = "open" | "approval";
export type MyStatus = "accepted" | "pending" | "declined" | null;

/** open_matches(): the Find a game board. Only open, future games the caller does not organise. */
export type OpenGameRow = {
  match_id: string; club_id: string; club_name: string; club_slug: string; town: string | null;
  sport: string; start_at: string; end_at: string | null;
  level_min: number | null; level_max: number | null; level_legacy: boolean; my_level: number | null;
  players_needed: number; joined: number; note: string | null; organizer_name: string | null;
  join_mode: JoinMode; i_joined: boolean; booking_id: string | null; court_name: string | null;
};

/** match_board(): one club's open games plus the caller's own, next N days (list use only). */
export type ClubGameRow = {
  match_id: string; club_id: string; club_name: string; club_slug: string;
  sport: string; start_at: string; end_at: string | null;
  level_min: number | null; level_max: number | null; level_legacy: boolean; my_level: number | null;
  players_needed: number; joined: number; pending: number; status: MatchStatus; closed_reason: ClosedReason;
  note: string | null; join_mode: JoinMode; organizer_id: string; organizer_name: string | null;
  my_status: MyStatus; i_organize: boolean; booking_id: string | null; court_name: string | null;
};

/**
 * match_detail() — migration 0067 (docs/m3/sql/0067_match_detail.draft.sql). NOT AVAILABLE until 0067
 * is approved and applied; see `MATCH_DETAIL_AVAILABLE` in lib/games.ts.
 * `organizer_id` and `booking_id` are null for anyone who is not the organiser, an accepted player,
 * club staff or admin; `pending` is null for everyone but the organiser (field review, safeguard S-A).
 */
export type GameDetail = {
  match_id: string; club_id: string | null; club_name: string | null; club_slug: string | null;
  club_timezone: string | null; town: string | null;
  sport: string; start_at: string; end_at: string | null;
  level_min: number | null; level_max: number | null; level_legacy: boolean; my_level: number | null;
  players_needed: number; joined: number; pending: number | null;
  status: MatchStatus; closed_reason: ClosedReason; court_lost: boolean;
  note: string | null; join_mode: JoinMode; organizer_id: string | null; organizer_name: string | null;
  my_status: MyStatus; i_organize: boolean; has_court: boolean; booking_id: string | null; court_name: string | null;
  started: boolean; finished: boolean; hidden: boolean;
};

/** match_participants(): organiser sees accepted + pending; accepted players see accepted; others nothing. */
export type ParticipantRow = {
  profile_id: string; name: string | null; level: number | null; level_legacy: string | null;
  is_organizer: boolean; status: "accepted" | "pending"; // the organiser's own row reads "accepted"
};

export type MyLevelRow = { sport: string; level: number };
