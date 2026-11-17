jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import {
  FAVOURITE_MESSAGES, FAVOURITES_AVAILABLE, favouriteFailure, favouriteKeys, FavouritesUnavailable, fetchFavourites, heartView,
  saveFavourite, toggleFavourite, useFavourites, useFavouriteToggle, withFavourite,
} from "../lib/favourites";

// These tests check the PHONE's handling. Who may read or change a favourite is the database's job,
// tested in supabase/tests/favourites/club_favourites.sh (RLS, grants, idempotency, inactive clubs).

const rpc = supabase.rpc as jest.Mock;
beforeEach(() => rpc.mockReset());
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

describe("not available until the migration is approved and applied", () => {
  it("is switched off in this build: no call, no hearts", async () => {
    expect(FAVOURITES_AVAILABLE).toBe(false);
    await expect(fetchFavourites()).rejects.toBeInstanceOf(FavouritesUnavailable);
    await expect(saveFavourite("c1", true)).rejects.toBeInstanceOf(FavouritesUnavailable);
    expect(rpc).not.toHaveBeenCalled();
    expect(heartView({ signedIn: true, available: false, favourite: false, clubName: "X" }).visible).toBe(false);
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

describe("toggleFavourite", () => {
  const setup = (initial: string[]) => {
    const qc = client();
    qc.setQueryData(favouriteKeys.mine("u1"), initial);
    return qc;
  };
  const list = (qc: QueryClient, u = "u1") => qc.getQueryData<string[]>(favouriteKeys.mine(u));

  it("shows the change at once, then keeps the server's answer", async () => {
    const qc = setup(["a"]);
    let release!: (v: boolean) => void;
    const save = jest.fn(() => new Promise<boolean>((r) => { release = r; }));
    const p = toggleFavourite({ qc, userId: "u1", currentUserId: () => "u1", clubId: "b", favourite: true, available: true, save });
    expect(list(qc)).toEqual(["b", "a"]); // optimistic
    release(true);
    await expect(p).resolves.toEqual({ ok: true, favourite: true });
    expect(list(qc)).toEqual(["b", "a"]);
    expect(save).toHaveBeenCalledWith("b", true, true);
  });

  it("a refusal (club gone) puts it back and says why", async () => {
    const qc = setup(["a"]);
    const save = jest.fn().mockRejectedValue({ message: "club_not_found", code: "P0001" });
    const r = await toggleFavourite({ qc, userId: "u1", currentUserId: () => "u1", clubId: "b", favourite: true, available: true, save });
    expect(r).toEqual({ ok: false, failure: { kind: "refused", message: FAVOURITE_MESSAGES.club_not_found, reason: "club_not_found" } });
    expect(list(qc)).toEqual(["a"]);
  });

  it("the cap is explained", () => {
    expect(favouriteFailure({ message: "too_many_favourites" })).toEqual({ kind: "refused", message: FAVOURITE_MESSAGES.too_many_favourites, reason: "too_many_favourites" });
  });

  it("no answer (offline): puts it back AND re-reads, because it may have been saved", async () => {
    const qc = setup(["a"]);
    const spy = jest.spyOn(qc, "invalidateQueries");
    const save = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
    const r = await toggleFavourite({ qc, userId: "u1", currentUserId: () => "u1", clubId: "a", favourite: false, available: true, save });
    expect(r).toEqual({ ok: false, failure: { kind: "network", message: FAVOURITE_MESSAGES.network } });
    expect(list(qc)).toEqual(["a"]);
    expect(spy).toHaveBeenCalledWith({ queryKey: favouriteKeys.mine("u1") });
    expect(save).toHaveBeenCalledTimes(1); // never retried automatically
  });

  it("an unknown server error is a generic message, with a re-read", async () => {
    const qc = setup([]);
    const spy = jest.spyOn(qc, "invalidateQueries");
    const r = await toggleFavourite({ qc, userId: "u1", currentUserId: () => "u1", clubId: "a", favourite: true, available: true, save: jest.fn().mockRejectedValue({ message: "boom", code: "XX000" }) });
    expect(r).toEqual({ ok: false, failure: { kind: "unknown", message: FAVOURITE_MESSAGES.unknown } });
    expect(spy).toHaveBeenCalled();
  });

  it("an expired session is reported as auth (the app signs in again)", () => {
    expect(favouriteFailure({ message: "JWT expired", code: "PGRST301" }).kind).toBe("auth");
  });

  it("signed out: nothing is sent", async () => {
    const save = jest.fn();
    const r = await toggleFavourite({ qc: client(), userId: null, currentUserId: () => null, clubId: "a", favourite: true, available: true, save });
    expect(r).toEqual({ ok: false, skipped: "signed-out" });
    expect(save).not.toHaveBeenCalled();
  });

  it("account changed while saving: the old account's answer never touches the new account's list", async () => {
    const qc = setup(["a"]);
    qc.setQueryData(favouriteKeys.mine("u2"), ["z"]);
    let who = "u1";
    let release!: (v: boolean) => void;
    const save = jest.fn(() => new Promise<boolean>((r) => { release = r; }));
    const p = toggleFavourite({ qc, userId: "u1", currentUserId: () => who, clubId: "b", favourite: true, available: true, save });
    who = "u2"; // signed out and another person signed in
    release(true);
    await expect(p).resolves.toEqual({ ok: false, skipped: "account-changed" });
    expect(list(qc, "u2")).toEqual(["z"]);
  });
});

describe("useFavouriteToggle — double tap", () => {
  it("two taps on the same heart while saving send one request", async () => {
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
