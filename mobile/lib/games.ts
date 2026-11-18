import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { Governorate } from "@shared/geo";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { shouldRetryRead } from "./query";
import { gameFailure } from "./gameErrors";
import { toOpenMatchesParams, type GameFilters } from "./gameFilters";
import type { AgendaRow } from "./bookings";
import type { ClubGameRow, GameDetail, MyLevelRow, OpenGameRow, ParticipantRow } from "./gameTypes";

/**
 * Find a Game data layer (docs/m3/05-architecture.md §5.1–5.2). Reads only: every call is one of the
 * existing database functions, under the caller's own session and RLS. No write is made here; game
 * actions are in lib/gameActions.ts, switched off until M3-H (hardening).
 */

/**
 * match_detail() exists only after migration 0067, which needs Paul's separate approval for staging
 * and for live. Until this is switched on (in the same change that ships 0067), the detail hook does
 * not call the server and reports `detail_unavailable`. A server without the function is reported
 * the same way (PostgREST PGRST202), never as a generic error.
 */
export const MATCH_DETAIL_AVAILABLE = false;

export class GameDetailUnavailable extends Error {
  constructor() {
    super("detail_unavailable");
    this.name = "GameDetailUnavailable";
  }
}
export const DETAIL_UNAVAILABLE_TEXT = "Game details arrive in the next update.";

/** Query keys. Prefixes make invalidation match M2 (invalidateQueries({ queryKey: [prefix] })). */
export const gameKeys = {
  board: (f: GameFilters) => ["games", f] as const,
  club: (clubId: string) => ["club-games", clubId] as const,
  detail: (id: string) => ["game", id] as const,
  people: (id: string) => ["game-people", id] as const,
  myLevels: ["my-levels"] as const,
  areas: ["areas"] as const,
  agenda: ["my-agenda"] as const, // the M2 key, shared with Bookings
};

/** Club → Games looks this many days ahead (05-architecture.md §5.2). */
export const CLUB_GAMES_DAYS = 14;

export async function fetchOpenGames(filters: GameFilters, now: Date = new Date()): Promise<OpenGameRow[]> {
  const { data, error } = await supabase.rpc("open_matches", toOpenMatchesParams(filters, now));
  if (error) throw error;
  return (data ?? []) as OpenGameRow[];
}

export async function fetchClubGames(clubId: string): Promise<ClubGameRow[]> {
  const { data, error } = await supabase.rpc("match_board", { p_club: clubId, p_days: CLUB_GAMES_DAYS });
  if (error) throw error;
  return (data ?? []) as ClubGameRow[];
}

/** null = the server returned no row: not visible to this caller (GR-2) or no such game. */
export async function fetchGameDetail(id: string, available: boolean = MATCH_DETAIL_AVAILABLE): Promise<GameDetail | null> {
  if (!available) throw new GameDetailUnavailable();
  const { data, error } = await supabase.rpc("match_detail", { p_match: id });
  if (error) {
    const e = error as { code?: unknown; message?: unknown };
    if (e.code === "PGRST202" || (typeof e.message === "string" && /could not find the function/i.test(e.message))) {
      throw new GameDetailUnavailable();
    }
    throw error;
  }
  const rows = (data ?? []) as GameDetail[];
  return rows[0] ?? null;
}

export async function fetchGamePeople(id: string): Promise<ParticipantRow[]> {
  const { data, error } = await supabase.rpc("match_participants", { p_match: id });
  if (error) throw error;
  return (data ?? []) as ParticipantRow[];
}

export async function fetchMyLevels(): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc("my_levels");
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as MyLevelRow[]) out[r.sport] = r.level;
  return out;
}

export async function fetchAreas(): Promise<Governorate[]> {
  const { data, error } = await supabase.rpc("areas");
  if (error) throw error;
  return (data ?? []) as Governorate[];
}

/** Every game hook takes `signedIn`: signed-out visitors never call a game function (J1, U9). */
type Gate = { signedIn: boolean };

export function useOpenGames(filters: GameFilters, { signedIn }: Gate) {
  return useQuery({ queryKey: gameKeys.board(filters), enabled: signedIn, staleTime: 15_000, queryFn: () => fetchOpenGames(filters) });
}

export function useClubGames(clubId: string | undefined, { signedIn }: Gate) {
  return useQuery({
    queryKey: gameKeys.club(clubId ?? ""), enabled: signedIn && !!clubId, staleTime: 15_000,
    queryFn: () => fetchClubGames(clubId!),
  });
}

export function useGame(id: string | undefined, { signedIn }: Gate) {
  return useQuery({
    queryKey: gameKeys.detail(id ?? ""), enabled: signedIn && !!id, staleTime: 5_000,
    // "unavailable" is a fact about the server, not a passing failure: don't retry it
    retry: (n, e) => !(e instanceof GameDetailUnavailable) && shouldRetryRead(n, e),
    queryFn: () => fetchGameDetail(id!),
  });
}

/**
 * Names and requests. Only call when the detail says names are visible (organiser or accepted
 * player): for anyone else the server returns nothing anyway — this just saves the call.
 */
export function useGamePeople(id: string | undefined, { signedIn, visible }: Gate & { visible: boolean }) {
  return useQuery({
    queryKey: gameKeys.people(id ?? ""), enabled: signedIn && visible && !!id, staleTime: 5_000,
    queryFn: () => fetchGamePeople(id!),
  });
}

export function useMyLevels({ signedIn }: Gate) {
  return useQuery({ queryKey: gameKeys.myLevels, enabled: signedIn, staleTime: 60_000, queryFn: fetchMyLevels });
}

/**
 * Area picker data. Gated like every other game hook (review, 17 Nov): the board that uses it is for
 * signed-in players only, so signed-out visitors make no call. Note: areas() itself is public
 * reference data (executable by anon since migrations 0032/0036, for club browsing); the gate is for
 * consistency, not because the server would refuse.
 */
export function useAreas({ signedIn }: Gate) {
  return useQuery({ queryKey: gameKeys.areas, enabled: signedIn, staleTime: 24 * 3_600_000, queryFn: fetchAreas });
}

/** Players (organiser first, as the server orders them) and, for the organiser, requests waiting. */
export function splitPeople(rows: ParticipantRow[]) {
  return {
    players: rows.filter((r) => r.status === "accepted"),
    requests: rows.filter((r) => r.status === "pending"),
  };
}

/** Bookings → Games rows: the M2 agenda's game rows (my_agenda kind 'match', id = game id). */
export function agendaGames(rows: AgendaRow[]): AgendaRow[] {
  return rows.filter((r) => r.kind === "match");
}

/**
 * After any change to a game (stage 3 onwards), refresh everything that can show it — the same
 * prefix invalidation M2 uses after a booking ("my-agenda", "day-slots").
 */
export function invalidateAfterGameChange(qc: QueryClient, gameId?: string) {
  if (gameId) {
    void qc.invalidateQueries({ queryKey: gameKeys.detail(gameId) });
    void qc.invalidateQueries({ queryKey: gameKeys.people(gameId) });
  }
  void qc.invalidateQueries({ queryKey: ["games"] });
  void qc.invalidateQueries({ queryKey: ["club-games"] });
  void qc.invalidateQueries({ queryKey: gameKeys.agenda });
}

/** What a game screen should show for a query's state. Pure, so every branch is unit-tested. */
export type LoadView =
  | { kind: "signed-out" }
  | { kind: "loading" }
  | { kind: "offline-empty" }
  | { kind: "ready"; stale: boolean }
  | { kind: "unavailable"; message: string }
  | { kind: "not-visible" }
  | { kind: "error"; failure: Failure };

export function loadView(q: {
  signedIn: boolean; online: boolean; hasData: boolean; dataIsNull?: boolean;
  isPending: boolean; fetchStatus: "fetching" | "paused" | "idle"; error: unknown;
}): LoadView {
  if (!q.signedIn) return { kind: "signed-out" };
  if (q.error instanceof GameDetailUnavailable) return { kind: "unavailable", message: DETAIL_UNAVAILABLE_TEXT };
  if (q.hasData) {
    if (q.dataIsNull) return { kind: "not-visible" };
    // cached data stays on screen while offline or after a failed refresh (Freshness says so)
    return { kind: "ready", stale: !q.online || q.error != null };
  }
  if (!q.online || q.fetchStatus === "paused") return { kind: "offline-empty" };
  if (q.error != null) return { kind: "error", failure: gameFailure(q.error) };
  return { kind: "loading" };
}
