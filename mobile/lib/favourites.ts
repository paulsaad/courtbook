import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { classify, type Failure } from "./errors";

/**
 * Favourite clubs (docs/favourites/README.md §A). Linked to the account, so they follow the player
 * to every device. The database owns the rules: a player reads and changes only their own
 * favourites (RLS + set_club_favourite), duplicates are impossible (primary key), inactive clubs
 * can't be added and aren't listed (my_favourite_clubs).
 *
 * The functions exist from migration 0087 (approved design; applying it to staging and live needs Paul's go). The
 * switch is on, but a server without the functions (PostgREST PGRST202) answers FavouritesUnavailable and the screens
 * then draw no heart (`favouritesShown`), so this app works the same against a database with or without 0087.
 */
export const FAVOURITES_AVAILABLE = true;

/** Hearts and the Home row appear only once the list has loaded from a server that has 0087. */
export function favouritesShown(q: { isSuccess: boolean; error: unknown }): boolean {
  return q.isSuccess && !(q.error instanceof FavouritesUnavailable);
}

/** Home's "Your clubs" row: the favourites with what the row shows (name, town), across every region. */
export type FavouriteClubRow = { club_id: string; name: string; slug: string; town: string | null; cover_url: string | null };
export function useFavouriteClubRows(userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["favourite-clubs", userId ?? ""],
    enabled: !!userId && enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_favourite_clubs");
      if (error) throw missingFunction(error) ? new FavouritesUnavailable() : error;
      return (data ?? []) as FavouriteClubRow[];
    },
  });
}

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
 * Keeps one account's favourites list consistent with the server while hearts are being tapped.
 *
 * The cache (["favourites", user]) is the single place the hearts and the list read from. Rules:
 *  1. A tap writes the wanted state into the cache at once (optimistic), after cancelling any
 *     fetch in flight so that fetch's older answer can't land on top.
 *  2. A fetch that STARTS while saves are pending can still return a list from before they were
 *     saved. Every fetched list is therefore re-applied with the pending wishes before anyone
 *     sees it (cache listener below) — a refresh never flips a heart back mid-save.
 *  3. One request per club at a time. Taps during a save only change the wish; when the save
 *     answers, the latest wish is sent if it differs (on → off → on sends at most two requests and
 *     ends where the player left it). The server function is idempotent, so this is safe.
 *  4. Each club's answer is applied to that club only — overlapping saves for different clubs never
 *     roll each other back.
 *  5. A refusal puts that club back to its last server-confirmed state, with the reason. No answer
 *     (offline / timeout / unknown error) does the same and marks the list for a re-read, because
 *     the change may or may not have been saved. Never retried automatically.
 *  6. When the last pending save settles, the list is re-read from the server, so whatever
 *     happened in between, the cache ends equal to the server.
 *  7. Answers that arrive after the account changed are dropped; nothing is written to any list.
 */
export function createFavouriteSync(o: {
  qc: QueryClient; userId: string; currentUserId: () => string | null;
  available?: boolean; save?: typeof saveFavourite;
}) {
  const key = favouriteKeys.mine(o.userId);
  const available = o.available ?? FAVOURITES_AVAILABLE;
  const save = o.save ?? saveFavourite;
  const wish = new Map<string, boolean>();       // latest wanted state per club, not yet confirmed
  const confirmed = new Map<string, boolean>();  // last state the server confirmed (or the list showed)
  const running = new Map<string, Promise<ToggleResult>>();
  let touched = false;

  const read = () => o.qc.getQueryData<string[]>(key) ?? [];
  const applyWishes = (ids: string[]) => {
    let out = ids;
    for (const [club, on] of wish) out = withFavourite(out, club, on);
    return out;
  };
  const set = (club: string, on: boolean) => o.qc.setQueryData<string[]>(key, (now) => withFavourite(now ?? [], club, on));
  const stale = () => o.currentUserId() !== o.userId;

  // rule 2: a fetched list (not one of our own writes) gets the pending wishes re-applied
  const unsubscribe = o.qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "success" || e.action.manual) return;
    if (e.query.queryHash !== o.qc.getQueryCache().find({ queryKey: key, exact: true })?.queryHash) return;
    if (wish.size === 0) return;
    const fetched = (e.action.data ?? []) as string[];
    const merged = applyWishes(fetched);
    if (merged.join() !== fetched.join()) o.qc.setQueryData<string[]>(key, merged);
  });

  async function run(club: string): Promise<ToggleResult> {
    let result: ToggleResult = { ok: false, skipped: "unavailable" };
    let resync = false;
    for (;;) {
      const want = wish.get(club);
      if (want === undefined) break;
      try {
        const state = await save(club, want, available);
        if (stale()) { result = { ok: false, skipped: "account-changed" }; break; }
        confirmed.set(club, state);
        touched = true;
        if (wish.get(club) === want) {
          wish.delete(club);
          set(club, state);
          result = { ok: true, favourite: state };
          break;
        }
        // the player changed their mind while this was saving: send the newer wish (rule 3)
      } catch (error) {
        if (stale()) { result = { ok: false, skipped: "account-changed" }; break; }
        wish.delete(club);
        set(club, confirmed.get(club) ?? false);
        const failure = favouriteFailure(error);
        if (failure.kind === "network" || failure.kind === "unknown") resync = true;
        touched = true;
        result = { ok: false, failure };
        break;
      }
    }
    running.delete(club);
    if (!stale() && running.size === 0 && (touched || resync)) {
      touched = false;
      void o.qc.invalidateQueries({ queryKey: key }); // rule 6
      // and Home's "Your clubs" rows (name, town), read separately: a row fetched while a save was still pending can
      // lack the club just added (A17, 28 Nov: re-added Batroun stayed off Home until the app restarted)
      void o.qc.invalidateQueries({ queryKey: ["favourite-clubs", o.userId] });
    }
    return result;
  }

  return {
    /** The player's tap. Resolves when this club's saving is over, with the outcome. */
    toggle(club: string, on: boolean): Promise<ToggleResult> {
      if (!available) return Promise.resolve({ ok: false, skipped: "unavailable" });
      if (stale()) return Promise.resolve({ ok: false, skipped: "account-changed" });
      if (!confirmed.has(club) && !running.has(club)) confirmed.set(club, read().includes(club));
      void o.qc.cancelQueries({ queryKey: key }); // rule 1 (reverts to our own last write, if any)
      wish.set(club, on);
      set(club, on);
      const inFlight = running.get(club);
      if (inFlight) return inFlight;
      const p = run(club);
      running.set(club, p);
      return p;
    },
    pending: () => wish.size,
    dispose: unsubscribe,
  };
}

/** Hook wrapper: one sync per signed-in account; signed-out taps send nothing. */
export function useFavouriteToggle(userId: string | null, available: boolean = FAVOURITES_AVAILABLE) {
  const qc = useQueryClient();
  const current = useRef(userId);
  current.current = userId;
  const sync = useMemo(
    () => (userId ? createFavouriteSync({ qc, userId, currentUserId: () => current.current, available }) : null),
    [qc, userId, available]
  );
  useEffect(() => () => sync?.dispose(), [sync]);
  return useCallback(
    (clubId: string, favourite: boolean): Promise<ToggleResult> =>
      sync ? sync.toggle(clubId, favourite) : Promise.resolve({ ok: false, skipped: available ? "signed-out" : "unavailable" }),
    [sync, available]
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
