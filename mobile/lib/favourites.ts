import { useCallback, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { classify, type Failure } from "./errors";
import { createSingleFlight } from "./singleFlight";

/**
 * Favourite clubs (docs/favourites/README.md §A). Linked to the account, so they follow the player
 * to every device. The database owns the rules: a player reads and changes only their own
 * favourites (RLS + set_club_favourite), duplicates are impossible (primary key), inactive clubs
 * can't be added and aren't listed (my_favourite_clubs).
 *
 * The functions exist only after the favourites migration, which needs Paul's approval for staging
 * and live. Until it ships, FAVOURITES_AVAILABLE stays false: no call is made and no heart is shown.
 * A server without the functions (PostgREST PGRST202) is treated the same way.
 */
export const FAVOURITES_AVAILABLE = false;

export const favouriteKeys = { mine: (userId: string) => ["favourites", userId] as const };

export class FavouritesUnavailable extends Error {
  constructor() { super("favourites_unavailable"); this.name = "FavouritesUnavailable"; }
}

function missingFunction(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === "PGRST202" || (typeof e.message === "string" && /could not find the function/i.test(e.message)));
}

/** Club ids, most recently added first; only clubs that are active now. */
export async function fetchFavourites(available: boolean = FAVOURITES_AVAILABLE): Promise<string[]> {
  if (!available) throw new FavouritesUnavailable();
  const { data, error } = await supabase.rpc("my_favourite_clubs");
  if (error) throw missingFunction(error) ? new FavouritesUnavailable() : error;
  return ((data ?? []) as { club_id: string }[]).map((r) => r.club_id);
}

/** Idempotent on the server: asking for the state it already has changes nothing. Returns the new state. */
export async function saveFavourite(clubId: string, favourite: boolean, available: boolean = FAVOURITES_AVAILABLE): Promise<boolean> {
  if (!available) throw new FavouritesUnavailable();
  const { data, error } = await supabase.rpc("set_club_favourite", { p_club: clubId, p_favourite: favourite });
  if (error) throw missingFunction(error) ? new FavouritesUnavailable() : error;
  return data === true;
}

export function useFavourites(userId: string | null, available: boolean = FAVOURITES_AVAILABLE) {
  return useQuery({
    queryKey: favouriteKeys.mine(userId ?? ""),
    enabled: !!userId && available,
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof FavouritesUnavailable) && classify(e).kind === "network" && n < 2,
    queryFn: () => fetchFavourites(available),
  });
}

export const FAVOURITE_MESSAGES = {
  club_not_found: "This club isn't available any more.",
  too_many_favourites: "You can keep up to 50 favourite clubs. Remove one to add another.",
  network: "Couldn't save your favourite. Check your connection and try again.",
  unknown: "Couldn't save your favourite. Try again.",
} as const;

export function favouriteFailure(error: unknown): Failure {
  const f = classify(error);
  if (f.kind === "auth") return f;
  if (f.kind === "network") return { kind: "network", message: FAVOURITE_MESSAGES.network };
  const msg = String((error as { message?: unknown })?.message ?? "");
  if (/\bclub_not_found\b/.test(msg)) return { kind: "refused", message: FAVOURITE_MESSAGES.club_not_found, reason: "club_not_found" };
  if (/\btoo_many_favourites\b/.test(msg)) return { kind: "refused", message: FAVOURITE_MESSAGES.too_many_favourites, reason: "too_many_favourites" };
  return { kind: "unknown", message: FAVOURITE_MESSAGES.unknown };
}

/** Pure list update used for the optimistic change: newest first, never a duplicate. */
export function withFavourite(ids: string[], clubId: string, favourite: boolean): string[] {
  const rest = ids.filter((id) => id !== clubId);
  return favourite ? [clubId, ...rest] : rest;
}

export type ToggleResult = { ok: true; favourite: boolean } | { ok: false; failure: Failure } | { ok: false; skipped: "signed-out" | "unavailable" | "account-changed" };

/**
 * One tap on a heart. Shows the change at once, then keeps whatever the server answers:
 *  - success → the server's state;
 *  - refusal (club gone, cap) → put back, say why;
 *  - no answer (offline, timeout) → put back AND re-read the list, because the change may or may
 *    not have been saved; the re-read shows the truth. Never retried automatically.
 * A second tap on the same club while one is in flight joins it (no duplicate request).
 * If the account changes while a request is in flight, its answer is ignored: it belongs to the
 * previous account and must not touch the new one's list.
 */
export async function toggleFavourite(o: {
  qc: QueryClient; userId: string | null; currentUserId: () => string | null; clubId: string; favourite: boolean;
  available?: boolean; save?: typeof saveFavourite;
}): Promise<ToggleResult> {
  const available = o.available ?? FAVOURITES_AVAILABLE;
  if (!o.userId) return { ok: false, skipped: "signed-out" };
  if (!available) return { ok: false, skipped: "unavailable" };
  const key = favouriteKeys.mine(o.userId);
  const before = o.qc.getQueryData<string[]>(key) ?? [];
  o.qc.setQueryData<string[]>(key, withFavourite(before, o.clubId, o.favourite));
  try {
    const state = await (o.save ?? saveFavourite)(o.clubId, o.favourite, available);
    if (o.currentUserId() !== o.userId) return { ok: false, skipped: "account-changed" };
    o.qc.setQueryData<string[]>(key, (now) => withFavourite(now ?? [], o.clubId, state));
    return { ok: true, favourite: state };
  } catch (error) {
    if (o.currentUserId() !== o.userId) return { ok: false, skipped: "account-changed" };
    o.qc.setQueryData<string[]>(key, (now) => withFavourite(now ?? [], o.clubId, before.includes(o.clubId)));
    const failure = favouriteFailure(error);
    if (failure.kind === "network" || failure.kind === "unknown") void o.qc.invalidateQueries({ queryKey: key });
    return { ok: false, failure };
  }
}

/** Hook wrapper: single flight per club, current user read at answer time. */
export function useFavouriteToggle(userId: string | null, available: boolean = FAVOURITES_AVAILABLE) {
  const qc = useQueryClient();
  const flight = useRef(createSingleFlight()).current;
  const current = useRef(userId);
  current.current = userId;
  return useCallback(
    (clubId: string, favourite: boolean) =>
      flight.run(`fav:${clubId}`, () => toggleFavourite({ qc, userId, currentUserId: () => current.current, clubId, favourite, available })),
    [qc, userId, available, flight]
  );
}

/** What the heart on a club card shows. Display only — the server decides. */
export function heartView(o: { signedIn: boolean; available: boolean; favourite: boolean; clubName: string }):
  { visible: boolean; pressed: boolean; label: string; action: "toggle" | "sign-in" | null } {
  if (!o.available) return { visible: false, pressed: false, label: "", action: null };
  if (!o.signedIn) return { visible: true, pressed: false, label: `Sign in to save ${o.clubName} as a favourite`, action: "sign-in" };
  return o.favourite
    ? { visible: true, pressed: true, label: `Remove ${o.clubName} from favourites`, action: "toggle" }
    : { visible: true, pressed: false, label: `Add ${o.clubName} to favourites`, action: "toggle" };
}
