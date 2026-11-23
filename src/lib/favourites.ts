"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Favourite clubs on the website (0087). One small store per page load, shared by every heart and by Home's "Your
 * clubs" row, so they never disagree. The database owns the rules (own rows only, cap of 50, visible clubs only).
 * A tap shows at once; one save per club at a time; a refusal puts the heart back with the reason.
 * Before 0087 exists, `available` stays false and no heart is drawn.
 *
 * Account isolation (M14 review A): the store holds ONE account's list, `owner`. Sign-in is a soft navigation here
 * (router.replace), so the store outlives it. Every load first reads the signed-in account from the browser session.
 * - A different account empties the store before anything is shown.
 * - An answer that arrives after the account changed, or after a newer load started, is dropped.
 * - A save that finishes after the account changed touches nothing.
 * - Signed out (`useFavourites(false)` or an auth event without a session) empties it too.
 */
export type FavouriteClub = {
  club_id: string; created_at: string; name: string; slug: string; town: string | null; district_code: string | null;
  governorate_code: string | null; cover_url: string | null; lat: number | string | null; lng: number | string | null; is_demo: boolean | null;
};
type State = { status: "idle" | "loading" | "ready" | "unavailable" | "failed"; clubs: FavouriteClub[]; ids: Set<string>; saving: Set<string>; message: string | null };

/** Choices still being saved: a list read during a save must not undo them (the app's rule 2). */
const pending = new Map<string, boolean>();
const withPending = (ids: Set<string>) => { const out = new Set(ids); pending.forEach((on, id) => { if (on) out.add(id); else out.delete(id); }); return out; };

const fresh = (): State => ({ status: "idle", clubs: [], ids: new Set(), saving: new Set(), message: null });
let state: State = fresh();
let owner: string | null = null;   // whose list `state` holds
let gen = 0;                       // bumped on every account change: older answers and saves are dropped
let loadSeq = 0;                   // only the newest load may write the list
let syncing: Promise<void> | null = null;
let syncGen = -1;
let watching = false;
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => { state = { ...state, ...s }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: State = fresh();

export const FAVOURITE_MESSAGES: Record<string, string> = {
  club_not_found: "This club isn't available any more.",
  too_many_favourites: "You can keep up to 50 favourite clubs. Remove one to add another.",
  failed: "Couldn't save your favourite. Try again.",
};

async function sessionUser(): Promise<string | null> {
  try { const { data } = await createClient().auth.getSession(); return data.session?.user?.id ?? null; }
  catch { return null; }
}

/** A different account (or none): forget everything about the previous one, at once. */
function switchTo(uid: string | null) {
  if (uid === owner) return;
  gen++; pending.clear(); owner = uid;
  state = fresh(); listeners.forEach((l) => l());
}

function watchAuth() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  try {
    createClient().auth.onAuthStateChange((_event, session) => {
      const uid = session?.user?.id ?? null;
      if (uid === owner) return;
      switchTo(uid);
      if (uid && listeners.size > 0) void sync();
    });
  } catch { /* the load-time check below still applies */ }
}

async function load() {
  const uid = await sessionUser();
  switchTo(uid);
  if (!uid) return;
  const g = gen, seq = ++loadSeq;
  if (state.status !== "ready") set({ status: "loading" });   // a reload keeps the hearts on screen
  const { data, error } = await createClient().rpc("my_favourite_clubs");
  if (g !== gen || seq !== loadSeq) return;                   // another account, or a newer load: not ours to show
  const now = await sessionUser();
  if (now !== uid) { switchTo(now); return load(); }    // signed in as someone else meanwhile (another tab)
  if (g !== gen || seq !== loadSeq) return;
  if (error) {
    const missing = error.code === "PGRST202" || /could not find the function/i.test(error.message ?? "");
    set({ status: missing ? "unavailable" : "failed" });
    return;
  }
  const clubs = (data ?? []) as FavouriteClub[];
  set({ status: "ready", clubs, ids: withPending(new Set(clubs.map((c) => c.club_id))) });
}

/** Make the store match the signed-in account: load if it is new or not loaded yet. One at a time. */
function sync(): Promise<void> {
  if (syncing && syncGen === gen) return syncing;   // one per account; a new account never waits for the old one's
  syncGen = gen;
  const mine: Promise<void> = (async () => {
    try {
      const uid = await sessionUser();
      if (uid !== owner || state.status === "idle" || state.status === "failed") await load();
    } finally { if (syncing === mine) syncing = null; }
  })();
  syncing = mine;
  return mine;
}

export function useFavourites(signedIn: boolean) {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(() => {
    watchAuth();
    if (signedIn) void sync();
    else switchTo(null);
  }, [signedIn]);
  return signedIn ? s : SERVER;
}

export async function toggleFavourite(clubId: string, on: boolean) {
  if (!owner || state.status !== "ready") return;
  if (state.saving.has(clubId)) return;   // one save per club at a time (the button is disabled meanwhile)
  const g = gen;
  pending.set(clubId, on);
  set({ ids: withPending(state.ids), saving: new Set([...state.saving, clubId]), message: null });
  let error: { message?: string } | null = null;
  try { ({ error } = await createClient().rpc("set_club_favourite", { p_club: clubId, p_favourite: on })); }
  catch { error = { message: "failed" }; }
  if (g !== gen) return;                  // the account changed meanwhile: this answer is about someone else's list
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
export function resetFavouritesForTests() {
  state = fresh(); owner = null; gen++; loadSeq = 0; syncing = null; watching = false; pending.clear();
}
