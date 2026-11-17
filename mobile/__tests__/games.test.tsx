jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import {
  agendaGames, CLUB_GAMES_DAYS, DETAIL_UNAVAILABLE_TEXT, fetchGameDetail, gameKeys, GameDetailUnavailable, invalidateAfterGameChange,
  loadView, MATCH_DETAIL_AVAILABLE, splitPeople, useAreas, useClubGames, useGame, useGamePeople, useMyLevels, useOpenGames,
} from "../lib/games";
import { DEFAULT_FILTERS } from "../lib/gameFilters";
import type { AgendaRow } from "../lib/bookings";
import type { ParticipantRow } from "../lib/gameTypes";

const rpc = supabase.rpc as jest.Mock;
beforeEach(() => rpc.mockReset());

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe("signed-out visitors never call a game function (J1, U9)", () => {
  it("board, club games, detail, people, levels and areas stay idle", async () => {
    const { wrapper } = setup();
    const out = { signedIn: false };
    const hooks = [
      await renderHook(() => useOpenGames(DEFAULT_FILTERS, out), { wrapper }),
      await renderHook(() => useClubGames("c1", out), { wrapper }),
      await renderHook(() => useGame("m1", out), { wrapper }),
      await renderHook(() => useGamePeople("m1", { ...out, visible: true }), { wrapper }),
      await renderHook(() => useMyLevels(out), { wrapper }),
      await renderHook(() => useAreas(out), { wrapper }),
    ];
    for (const h of hooks) expect(h.result.current.fetchStatus).toBe("idle");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("existing read functions", () => {
  it("the board calls open_matches with the converted filters", async () => {
    rpc.mockResolvedValueOnce({ data: [{ match_id: "m1" }], error: null });
    const { wrapper } = setup();
    const { result } = await renderHook(() => useOpenGames({ ...DEFAULT_FILTERS, sport: "padel" }, { signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledWith("open_matches", expect.objectContaining({ p_sport: "padel", p_fit: null, p_limit: 100, p_from: null }));
    expect(result.current.data).toEqual([{ match_id: "m1" }]);
  });

  it("club games call match_board for 14 days", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    const { wrapper } = setup();
    const { result } = await renderHook(() => useClubGames("c1", { signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledWith("match_board", { p_club: "c1", p_days: CLUB_GAMES_DAYS });
    expect(CLUB_GAMES_DAYS).toBe(14);
  });

  it("people are fetched only when names are visible to this viewer", async () => {
    const { wrapper } = setup();
    const hidden = await renderHook(() => useGamePeople("m1", { signedIn: true, visible: false }), { wrapper });
    expect(hidden.result.current.fetchStatus).toBe("idle");
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ data: [], error: null });
    const shown = await renderHook(() => useGamePeople("m1", { signedIn: true, visible: true }), { wrapper });
    await waitFor(() => expect(shown.result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledWith("match_participants", { p_match: "m1" });
  });

  it("areas are read with the areas() function once signed in", async () => {
    rpc.mockResolvedValueOnce({ data: [{ code: "north", name_en: "North", name_ar: "", districts: [] }], error: null });
    const { wrapper } = setup();
    const { result } = await renderHook(() => useAreas({ signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledWith("areas");
    expect(result.current.data?.[0].code).toBe("north");
  });

  it("levels become a sport → level map", async () => {
    rpc.mockResolvedValueOnce({ data: [{ sport: "padel", level: 5 }, { sport: "tennis", level: 3 }], error: null });
    const { wrapper } = setup();
    const { result } = await renderHook(() => useMyLevels({ signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ padel: 5, tennis: 3 });
  });

  it("a server refusal reaches the screen as an error (the server decides, not the app)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "not_authenticated" } });
    const { wrapper } = setup();
    const { result } = await renderHook(() => useOpenGames(DEFAULT_FILTERS, { signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(loadView({ signedIn: true, online: true, hasData: false, isPending: true, fetchStatus: "idle", error: result.current.error })).toEqual({
      kind: "error", failure: { kind: "auth", message: "Your session has ended. Sign in again to continue." },
    });
  });
});

describe("match_detail is unavailable until migration 0067 is approved and applied", () => {
  it("is switched off in this build", () => {
    expect(MATCH_DETAIL_AVAILABLE).toBe(false);
  });

  it("the hook does not call the server and reports 'unavailable' without retrying", async () => {
    const { wrapper } = setup();
    const { result } = await renderHook(() => useGame("m1", { signedIn: true }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.error).toBeInstanceOf(GameDetailUnavailable);
    expect(loadView({ signedIn: true, online: true, hasData: false, isPending: true, fetchStatus: "idle", error: result.current.error }))
      .toEqual({ kind: "unavailable", message: DETAIL_UNAVAILABLE_TEXT });
  });

  it("once switched on, a server without the function is still 'unavailable', not a generic error", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function public.match_detail(p_match) in the schema cache" } });
    await expect(fetchGameDetail("m1", true)).rejects.toBeInstanceOf(GameDetailUnavailable);
  });

  it("once switched on: one row → the game; no row → null (not visible, GR-2); other errors pass through", async () => {
    rpc.mockResolvedValueOnce({ data: [{ match_id: "m1" }], error: null });
    await expect(fetchGameDetail("m1", true)).resolves.toEqual({ match_id: "m1" });
    expect(rpc).toHaveBeenCalledWith("match_detail", { p_match: "m1" });
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(fetchGameDetail("m1", true)).resolves.toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Network request failed" } });
    await expect(fetchGameDetail("m1", true)).rejects.toEqual({ message: "Network request failed" });
  });
});

describe("loadView — every screen state", () => {
  const q = { signedIn: true, online: true, hasData: false, isPending: true, fetchStatus: "fetching" as const, error: null as unknown };
  it("signed out", () => expect(loadView({ ...q, signedIn: false })).toEqual({ kind: "signed-out" }));
  it("loading", () => expect(loadView(q)).toEqual({ kind: "loading" }));
  it("offline with nothing cached", () => {
    expect(loadView({ ...q, online: false })).toEqual({ kind: "offline-empty" });
    expect(loadView({ ...q, fetchStatus: "paused" })).toEqual({ kind: "offline-empty" });
  });
  it("offline with cached data keeps showing it, marked stale", () => {
    expect(loadView({ ...q, hasData: true, online: false, isPending: false })).toEqual({ kind: "ready", stale: true });
  });
  it("a failed refresh keeps cached data, marked stale", () => {
    expect(loadView({ ...q, hasData: true, isPending: false, error: new TypeError("Network request failed") })).toEqual({ kind: "ready", stale: true });
  });
  it("fresh data", () => expect(loadView({ ...q, hasData: true, isPending: false })).toEqual({ kind: "ready", stale: false }));
  it("no row from the server → not visible", () => expect(loadView({ ...q, hasData: true, dataIsNull: true })).toEqual({ kind: "not-visible" }));
  it("network error with nothing cached", () => {
    expect(loadView({ ...q, fetchStatus: "idle", error: new TypeError("Network request failed") })).toEqual({
      kind: "error", failure: { kind: "network", message: "No connection. Check your internet and try again." },
    });
  });
  it("unknown server error", () => {
    expect(loadView({ ...q, fetchStatus: "idle", error: { message: "boom", code: "XX000" } })).toEqual({
      kind: "error", failure: { kind: "unknown", message: "Something went wrong. Try again." },
    });
  });
});

describe("helpers", () => {
  it("splitPeople keeps the server's order and separates requests", () => {
    const rows = [
      { profile_id: "o", name: "Rami", is_organizer: true, status: "accepted" },
      { profile_id: "a", name: "Adam", is_organizer: false, status: "accepted" },
      { profile_id: "n", name: "Nour", is_organizer: false, status: "pending" },
    ] as ParticipantRow[];
    expect(splitPeople(rows)).toEqual({ players: rows.slice(0, 2), requests: rows.slice(2) });
  });

  it("agendaGames keeps the game rows of the M2 agenda", () => {
    const rows = [{ kind: "booking", id: "b1" }, { kind: "match", id: "m1" }] as AgendaRow[];
    expect(agendaGames(rows).map((r) => r.id)).toEqual(["m1"]);
  });

  it("invalidation refreshes everything that can show the game, with M2's agenda key", () => {
    const { client } = setup();
    const spy = jest.spyOn(client, "invalidateQueries");
    invalidateAfterGameChange(client, "m1");
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey)).toEqual([
      ["game", "m1"], ["game-people", "m1"], ["games"], ["club-games"], ["my-agenda"],
    ]);
    expect(gameKeys.agenda).toEqual(["my-agenda"]);
  });
});
