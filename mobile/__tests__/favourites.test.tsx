jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import {
  FAVOURITE_MESSAGES, FAVOURITES_AVAILABLE, favouritesShown, favouriteFailure, favouriteKeys, FavouritesUnavailable, fetchFavourites, heartView,
  createFavouriteSync, saveFavourite, useFavourites, useFavouriteToggle, withFavourite,
} from "../lib/favourites";

// These tests check the PHONE's handling. Who may read or change a favourite is the database's job,
// tested in supabase/tests/favourites/club_favourites.sh (RLS, grants, idempotency, inactive clubs).

const rpc = supabase.rpc as jest.Mock;
beforeEach(() => rpc.mockReset());
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

/** Re-reads of the favourites list itself (Home's "Your clubs" rows are re-read alongside since A17 F3). */
const listReads = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey)?.startsWith('["favourites"')).length;
const rowReads = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey)?.startsWith('["favourite-clubs"')).length;

describe("available only where the server has 0087", () => {
  // 23 Nov: the switch is on (0087 written); a server without the functions still means no call result, no hearts
  it("switched on; a switched-off build makes no call and draws no hearts", async () => {
    expect(FAVOURITES_AVAILABLE).toBe(true);
    await expect(fetchFavourites(false)).rejects.toBeInstanceOf(FavouritesUnavailable);
    await expect(saveFavourite("c1", true, false)).rejects.toBeInstanceOf(FavouritesUnavailable);
    expect(rpc).not.toHaveBeenCalled();
    expect(heartView({ signedIn: true, available: false, favourite: false, clubName: "X" }).visible).toBe(false);
  });
  it("hearts are shown only once the list loaded from a server that has 0087", () => {
    expect(favouritesShown({ isSuccess: true, error: null })).toBe(true);
    expect(favouritesShown({ isSuccess: false, error: new FavouritesUnavailable() })).toBe(false);
    expect(favouritesShown({ isSuccess: false, error: null })).toBe(false);   // still loading: no heart that might lie
  });
  it("a server without the functions is 'unavailable', not an error to show", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function public.my_favourite_clubs" } });
    await expect(fetchFavourites(true)).rejects.toBeInstanceOf(FavouritesUnavailable);
  });
});

describe("reading", () => {
  it("returns club ids in the server's order (newest first)", async () => {
    rpc.mockResolvedValueOnce({ data: [{ club_id: "b", created_at: "2" }, { club_id: "a", created_at: "1" }], error: null });
    await expect(fetchFavourites(true)).resolves.toEqual(["b", "a"]);
    expect(rpc).toHaveBeenCalledWith("my_favourite_clubs");
  });
  it("signed out: the hook makes no call", async () => {
    const qc = client();
    const { result } = await renderHook(() => useFavourites(null, true), { wrapper: wrap(qc) });
    expect(result.current.fetchStatus).toBe("idle");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("cache is per account: two users never share a list", () => {
    expect(favouriteKeys.mine("u1")).not.toEqual(favouriteKeys.mine("u2"));
  });
  it("a server error reaches the screen as an error", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom", code: "XX000" } });
    const qc = client();
    const { result } = await renderHook(() => useFavourites("u1", true), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("withFavourite", () => {
  it("adds to the front, never twice; removes cleanly", () => {
    expect(withFavourite(["a", "b"], "c", true)).toEqual(["c", "a", "b"]);
    expect(withFavourite(["a", "b"], "b", true)).toEqual(["b", "a"]);
    expect(withFavourite(["a", "b"], "a", false)).toEqual(["b"]);
    expect(withFavourite([], "a", false)).toEqual([]);
  });
});

// ---- saving -------------------------------------------------------------------------------------

/** A save the test resolves by hand, to hold requests "in flight". */
function controllableSave() {
  const calls: { club: string; on: boolean; resolve: (v: boolean) => void; reject: (e: unknown) => void }[] = [];
  const save = jest.fn((club: string, on: boolean) => new Promise<boolean>((resolve, reject) => { calls.push({ club, on, resolve, reject }); }));
  return { save, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("favourite sync — basic outcomes", () => {
  const setup = (initial: string[], who: () => string | null = () => "u1") => {
    const qc = client();
    qc.setQueryData(favouriteKeys.mine("u1"), initial);
    const { save, calls } = controllableSave();
    const sync = createFavouriteSync({ qc, userId: "u1", currentUserId: who, available: true, save });
    return { qc, save, calls, sync, list: () => qc.getQueryData<string[]>(favouriteKeys.mine("u1")) };
  };

  it("shows the change at once, then keeps the server's answer, then re-reads the list once", async () => {
    const t = setup(["a"]);
    const spy = jest.spyOn(t.qc, "invalidateQueries");
    const p = t.sync.toggle("b", true);
    expect(t.list()).toEqual(["b", "a"]); // optimistic
    t.calls[0].resolve(true);
    await expect(p).resolves.toEqual({ ok: true, favourite: true });
    expect(t.list()).toEqual(["b", "a"]);
    expect(listReads(spy)).toBe(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: favouriteKeys.mine("u1") });
    expect(rowReads(spy)).toBe(1);
  });

  it("a refusal (club gone) puts that club back and says why", async () => {
    const t = setup(["a"]);
    const p = t.sync.toggle("b", true);
    t.calls[0].reject({ message: "club_not_found", code: "P0001" });
    await expect(p).resolves.toEqual({ ok: false, failure: { kind: "refused", message: FAVOURITE_MESSAGES.club_not_found, reason: "club_not_found" } });
    expect(t.list()).toEqual(["a"]);
  });

  it("no answer (offline): puts it back, re-reads, and is not retried", async () => {
    const t = setup(["a"]);
    const spy = jest.spyOn(t.qc, "invalidateQueries");
    const p = t.sync.toggle("a", false);
    expect(t.list()).toEqual([]);
    t.calls[0].reject(new TypeError("Network request failed"));
    await expect(p).resolves.toEqual({ ok: false, failure: { kind: "network", message: FAVOURITE_MESSAGES.network } });
    expect(t.list()).toEqual(["a"]);
    expect(spy).toHaveBeenCalledWith({ queryKey: favouriteKeys.mine("u1") });
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("an unknown server error: generic message, re-read", async () => {
    const t = setup([]);
    const spy = jest.spyOn(t.qc, "invalidateQueries");
    const p = t.sync.toggle("a", true);
    t.calls[0].reject({ message: "boom", code: "XX000" });
    await expect(p).resolves.toEqual({ ok: false, failure: { kind: "unknown", message: FAVOURITE_MESSAGES.unknown } });
    expect(spy).toHaveBeenCalled();
  });

  it("the cap and an expired session are explained", () => {
    expect(favouriteFailure({ message: "too_many_favourites" })).toEqual({ kind: "refused", message: FAVOURITE_MESSAGES.too_many_favourites, reason: "too_many_favourites" });
    expect(favouriteFailure({ message: "JWT expired", code: "PGRST301" }).kind).toBe("auth");
  });

  it("account changed while saving: the old answer is dropped and no list is written", async () => {
    let who = "u1";
    const t = setup(["a"], () => who);
    t.qc.setQueryData(favouriteKeys.mine("u2"), ["z"]);
    const spy = jest.spyOn(t.qc, "invalidateQueries");
    const p = t.sync.toggle("b", true);
    who = "u2";
    t.calls[0].resolve(true);
    await expect(p).resolves.toEqual({ ok: false, skipped: "account-changed" });
    expect(t.qc.getQueryData(favouriteKeys.mine("u2"))).toEqual(["z"]);
    expect(spy).not.toHaveBeenCalled();
    await expect(t.sync.toggle("c", true)).resolves.toEqual({ ok: false, skipped: "account-changed" });
    expect(t.save).toHaveBeenCalledTimes(1);
  });
});

describe("favourite sync — overlapping taps and refreshes (regressions)", () => {
  const setup = (initial: string[]) => {
    const qc = client();
    qc.setQueryData(favouriteKeys.mine("u1"), initial);
    const { save, calls } = controllableSave();
    const sync = createFavouriteSync({ qc, userId: "u1", currentUserId: () => "u1", available: true, save });
    return { qc, save, calls, sync, list: () => qc.getQueryData<string[]>(favouriteKeys.mine("u1")) };
  };

  it("a refresh that lands mid-save with the old list does not flip the heart back", async () => {
    const t = setup(["a"]);
    const p = t.sync.toggle("b", true);
    // e.g. the app came back to the foreground: a fetch returns the list from before the save
    await t.qc.fetchQuery({ queryKey: favouriteKeys.mine("u1"), queryFn: async () => ["a"], staleTime: 0 });
    expect(t.list()).toEqual(["b", "a"]);
    t.calls[0].resolve(true);
    await p;
    expect(t.list()).toEqual(["b", "a"]);
  });

  it("a fetch already in flight when the heart is tapped can't overwrite it when it returns", async () => {
    const t = setup(["a"]);
    let answer!: (v: string[]) => void;
    const fetching = t.qc.fetchQuery({ queryKey: favouriteKeys.mine("u1"), queryFn: () => new Promise<string[]>((r) => { answer = r; }), staleTime: 0 }).catch(() => null);
    await flush();
    const p = t.sync.toggle("b", true);
    answer(["a"]); // the old list arrives after the tap
    await fetching;
    await flush();
    expect(t.list()).toEqual(["b", "a"]);
    t.calls[0].resolve(true);
    await p;
    expect(t.list()).toEqual(["b", "a"]);
  });

  it("on → off while saving: the latest wish is sent next and is where it ends", async () => {
    const t = setup([]);
    const p1 = t.sync.toggle("b", true);
    const p2 = t.sync.toggle("b", false);
    expect(t.list()).toEqual([]);
    expect(t.save).toHaveBeenCalledTimes(1); // one request per club at a time
    t.calls[0].resolve(true);
    await flush();
    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.calls[1]).toMatchObject({ club: "b", on: false });
    expect(t.list()).toEqual([]); // the heart never shows the stale "on" in between
    t.calls[1].resolve(false);
    await expect(p1).resolves.toEqual({ ok: true, favourite: false });
    await expect(p2).resolves.toEqual({ ok: true, favourite: false });
    expect(t.list()).toEqual([]);
  });

  it("on → off → on while saving: one request, since the wish ends where the first request went", async () => {
    const t = setup([]);
    const p = t.sync.toggle("b", true);
    void t.sync.toggle("b", false);
    void t.sync.toggle("b", true);
    t.calls[0].resolve(true);
    await expect(p).resolves.toEqual({ ok: true, favourite: true });
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.list()).toEqual(["b"]);
  });

  it("a double tap with the same intent sends one request", async () => {
    const t = setup([]);
    const a = t.sync.toggle("b", true), b = t.sync.toggle("b", true);
    expect(t.save).toHaveBeenCalledTimes(1);
    t.calls[0].resolve(true);
    await expect(Promise.all([a, b])).resolves.toEqual([{ ok: true, favourite: true }, { ok: true, favourite: true }]);
  });

  it("overlapping saves for different clubs: one failing never rolls back the other", async () => {
    const t = setup(["x"]);
    const pa = t.sync.toggle("a", true);
    const pb = t.sync.toggle("b", true);
    expect(t.list()).toEqual(["b", "a", "x"]);
    t.calls[0].reject({ message: "club_not_found" }); // a refused
    await pa;
    expect(t.list()).toEqual(["b", "x"]); // b still shown as pending-on
    t.calls[1].resolve(true);
    await pb;
    expect(t.list()).toEqual(["b", "x"]);
  });

  it("the list is re-read once, only after the LAST pending save settles", async () => {
    const t = setup([]);
    const spy = jest.spyOn(t.qc, "invalidateQueries");
    const pa = t.sync.toggle("a", true);
    const pb = t.sync.toggle("b", true);
    t.calls[0].resolve(true);
    await pa;
    expect(spy).not.toHaveBeenCalled(); // b still saving: a re-read now could show b off
    t.calls[1].resolve(true);
    await pb;
    expect(listReads(spy)).toBe(1);
    expect(rowReads(spy)).toBe(1);
  });

  it("after everything settles, the re-read makes the cache equal to the server", async () => {
    const qc = client();
    const server = new Set<string>(["a"]);
    qc.setQueryData(favouriteKeys.mine("u1"), ["a"]);
    // keep an observer so the re-read actually refetches
    const observer = new QueryObserver(qc, { queryKey: favouriteKeys.mine("u1"), queryFn: async () => [...server], staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    const save = jest.fn(async (club: string, on: boolean) => { if (on) server.add(club); else server.delete(club); return on; });
    const sync = createFavouriteSync({ qc, userId: "u1", currentUserId: () => "u1", available: true, save });
    await Promise.all([sync.toggle("b", true), sync.toggle("a", false), sync.toggle("c", true), sync.toggle("c", false)]);
    await waitFor(() => expect(new Set(qc.getQueryData<string[]>(favouriteKeys.mine("u1")))).toEqual(server));
    expect([...server].sort()).toEqual(["b"]);
    unsubscribe();
    sync.dispose();
  });

  it("not available / signed out: nothing is sent", async () => {
    const qc = client();
    const save = jest.fn();
    const sync = createFavouriteSync({ qc, userId: "u1", currentUserId: () => "u1", available: false, save });
    await expect(sync.toggle("a", true)).resolves.toEqual({ ok: false, skipped: "unavailable" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("useFavouriteToggle", () => {
  it("two taps on the same heart while saving send one request, through the real function", async () => {
    const qc = client();
    qc.setQueryData(favouriteKeys.mine("u1"), []);
    let release!: (v: { data: boolean; error: null }) => void;
    rpc.mockImplementation(() => new Promise((r) => { release = r; }));
    const { result } = await renderHook(() => useFavouriteToggle("u1", true), { wrapper: wrap(qc) });
    let a!: Promise<unknown>, b!: Promise<unknown>;
    await act(async () => {
      a = result.current("c1", true);
      b = result.current("c1", true);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_club_favourite", { p_club: "c1", p_favourite: true });
    await act(async () => { release({ data: true, error: null }); await Promise.all([a, b]); });
    expect(qc.getQueryData(favouriteKeys.mine("u1"))).toEqual(["c1"]);
  });

  it("signed out: a tap sends nothing", async () => {
    const qc = client();
    const { result } = await renderHook(() => useFavouriteToggle(null, true), { wrapper: wrap(qc) });
    await expect(result.current("c1", true)).resolves.toEqual({ ok: false, skipped: "signed-out" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("heartView", () => {
  it("signed out: visible, asks to sign in", () => {
    expect(heartView({ signedIn: false, available: true, favourite: false, clubName: "Batroun" }))
      .toEqual({ visible: true, pressed: false, label: "Sign in to save Batroun as a favourite", action: "sign-in" });
  });
  it("labels say what a tap will do", () => {
    expect(heartView({ signedIn: true, available: true, favourite: false, clubName: "Batroun" }).label).toBe("Add Batroun to favourites");
    expect(heartView({ signedIn: true, available: true, favourite: true, clubName: "Batroun" }))
      .toEqual({ visible: true, pressed: true, label: "Remove Batroun from favourites", action: "toggle" });
  });
});
