"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Favourite clubs on the website (0087). One small store per page load, shared by every heart and by Home's "Your
 * clubs" row, so they never disagree. The database owns the rules (own rows only, cap of 50, visible clubs only).
 * A tap shows at once; one save per club at a time; a refusal puts the heart back with the reason.
 * Before 0087 exists, `available` stays false and no heart is drawn.
 */
export type FavouriteClub = {
  club_id: string; created_at: string; name: string; slug: string; town: string | null; district_code: string | null;
  governorate_code: string | null; cover_url: string | null; lat: number | string | null; lng: number | string | null; is_demo: boolean | null;
};
type State = { status: "idle" | "loading" | "ready" | "unavailable" | "failed"; clubs: FavouriteClub[]; ids: Set<string>; saving: Set<string>; message: string | null };

/** Choices still being saved: a list read during a save must not undo them (the app's rule 2). */
const pending = new Map<string, boolean>();
const withPending = (ids: Set<string>) => { const out = new Set(ids); pending.forEach((on, id) => { if (on) out.add(id); else out.delete(id); }); return out; };

let state: State = { status: "idle", clubs: [], ids: new Set(), saving: new Set(), message: null };
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => { state = { ...state, ...s }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: State = { status: "idle", clubs: [], ids: new Set(), saving: new Set(), message: null };

export const FAVOURITE_MESSAGES: Record<string, string> = {
  club_not_found: "This club isn't available any more.",
  too_many_favourites: "You can keep up to 50 favourite clubs. Remove one to add another.",
  failed: "Couldn't save your favourite. Try again.",
};

async function load() {
  set({ status: "loading" });
  const { data, error } = await createClient().rpc("my_favourite_clubs");
  if (error) {
    const missing = error.code === "PGRST202" || /could not find the function/i.test(error.message ?? "");
    set({ status: missing ? "unavailable" : "failed" });
    return;
  }
  const clubs = (data ?? []) as FavouriteClub[];
  set({ status: "ready", clubs, ids: withPending(new Set(clubs.map((c) => c.club_id))) });
}

export function useFavourites(signedIn: boolean) {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(() => { if (signedIn && state.status === "idle") void load(); }, [signedIn]);
  return s;
}

export async function toggleFavourite(clubId: string, on: boolean) {
  if (state.saving.has(clubId)) return;   // one save per club at a time (the button is disabled meanwhile)
  pending.set(clubId, on);
  set({ ids: withPending(state.ids), saving: new Set([...state.saving, clubId]), message: null });
  let error: { message?: string } | null = null;
  try { ({ error } = await createClient().rpc("set_club_favourite", { p_club: clubId, p_favourite: on })); }
  catch { error = { message: "failed" }; }
  pending.delete(clubId);
  const saving = new Set(state.saving); saving.delete(clubId);
  if (error) {
    const back = new Set(state.ids);
    if (on) back.delete(clubId); else back.add(clubId);
    const code = error.message && /^[a-z_]+$/.test(error.message) ? error.message : "failed";
    set({ ids: back, saving, message: FAVOURITE_MESSAGES[code] ?? FAVOURITE_MESSAGES.failed });
    return;
  }
  set({ saving });
  void load();   // the list (and Home's row) ends equal to the server
}

/** Test hook: a fresh store. */
export function resetFavouritesForTests() { state = { ...SERVER, ids: new Set(), saving: new Set() }; pending.clear(); }
