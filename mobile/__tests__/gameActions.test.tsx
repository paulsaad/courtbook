jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import {
  actionBusy, actionKey, GAME_RPC_ARGS, GAME_WRITES_AVAILABLE, gameWritesFor, JOIN_LATER_TEXT, MANAGE_LATER_TEXT, outcomeOf, rpcFor,
  runGameAction, useGameActions, type GameAction,
} from "../lib/gameActions";
import { COURT_PAUSED, GAME_ERRORS } from "../lib/gameErrors";
import { gameKeys } from "../lib/games";

const rpc = supabase.rpc as jest.Mock;
beforeEach(() => rpc.mockReset());

const G = "11111111-0000-4000-8000-000000000001";
const P = "22222222-0000-4000-8000-000000000002";
const ALL: GameAction[] = [
  { kind: "join" }, { kind: "leave" }, { kind: "decide", profileId: P, accept: true },
  { kind: "status", status: "closed" }, { kind: "hide", hidden: true },
  { kind: "edit", edit: { playersNeeded: 4, levelMin: 3, levelMax: 6, note: "Friendly", joinMode: "approval" } },
  { kind: "remove", profileId: P }, { kind: "resolveCourt", bookingId: null },
];
const ORGANISER = new Set(["decide", "status", "edit", "remove", "resolveCourt"]);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("writes are on only against the staging database, where 0072 is applied", () => {
  it("staging on; live, unknown and missing off", () => {
    expect(gameWritesFor("https://pwznauyioqykdwodwpvx.supabase.co")).toBe(true);
    expect(gameWritesFor("https://pwznauyioqykdwodwpvx.supabase.co/")).toBe(true);
    expect(gameWritesFor("https://lgujfbwunokobjxlvpuf.supabase.co")).toBe(false);
    expect(gameWritesFor("https://abcdefghijklmnopqrst.supabase.co")).toBe(false);
    expect(gameWritesFor("")).toBe(false);
    expect(gameWritesFor(undefined)).toBe(false);
  });
  it("this bundle follows its database", () => {
    expect(GAME_WRITES_AVAILABLE).toBe(gameWritesFor(process.env.EXPO_PUBLIC_SUPABASE_URL));
  });
  it("with the switch off, no action reaches the server and each says when it arrives", async () => {
    const qc = client();
    for (const a of ALL) {
      const out = await runGameAction(qc, G, a, { available: false });
      expect(out.kind).toBe("refused");
      if (out.kind === "refused") expect(out.failure.message).toBe(ORGANISER.has(a.kind) ? MANAGE_LATER_TEXT : JOIN_LATER_TEXT);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("each action calls its function with the database's argument names", () => {
  it.each(ALL.map((a) => [a.kind, a] as const))("%s", (_k, a) => {
    const { fn, args } = rpcFor(G, a);
    expect(Object.keys(args)).toEqual(GAME_RPC_ARGS[fn as keyof typeof GAME_RPC_ARGS]);
    expect(args.p_match).toBe(G);
  });
  it("every listed function is used by some action", () => {
    const used = new Set(ALL.map((a) => rpcFor(G, a).fn));
    expect([...used].sort()).toEqual(Object.keys(GAME_RPC_ARGS).sort());
  });
  it("going ahead without a court sends an explicit null booking", () => {
    expect(rpcFor(G, { kind: "resolveCourt", bookingId: null }).args).toEqual({ p_match: G, p_booking: null });
  });
  it("removing two different players is not blocked by each other", () => {
    expect(actionKey(G, { kind: "remove", profileId: "a" })).not.toBe(actionKey(G, { kind: "remove", profileId: "b" }));
  });
  it("edit sends every field, nulls included", () => {
    const { args } = rpcFor(G, { kind: "edit", edit: { playersNeeded: 2, levelMin: null, levelMax: null, note: null, joinMode: "open" } });
    expect(args).toEqual({ p_match: G, p_players_needed: 2, p_level_min: null, p_level_max: null, p_note: null, p_join_mode: "open" });
  });
});

describe("outcomes (§5.3)", () => {
  it("join reports accepted or pending from the server", async () => {
    const qc = client();
    rpc.mockResolvedValueOnce({ data: "pending", error: null });
    expect(await runGameAction(qc, G, { kind: "join" }, { available: true })).toEqual({ kind: "done", joined: "pending" });
    rpc.mockResolvedValueOnce({ data: "accepted", error: null });
    expect(await runGameAction(qc, G, { kind: "join" }, { available: true })).toEqual({ kind: "done", joined: "accepted" });
  });

  it("a refusal gives the game sentence", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "match_full", code: "P0001" } });
    const out = await runGameAction(client(), G, { kind: "join" }, { available: true });
    expect(out).toEqual({ kind: "refused", failure: { kind: "refused", message: GAME_ERRORS.match_full, reason: "match_full" } });
  });

  it("match_closed on a game whose court was cancelled reads as the pause (GR-9)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "match_closed", code: "P0001" } });
    const out = await runGameAction(client(), G, { kind: "join" }, { available: true, courtLost: true });
    expect(out.kind === "refused" && out.failure.message).toBe(COURT_PAUSED);
  });

  it("no connection mid-call is uncertain: not retried, the game is re-read", async () => {
    const qc = client();
    const spy = jest.spyOn(qc, "invalidateQueries");
    rpc.mockRejectedValueOnce(new TypeError("Network request failed"));
    const out = await runGameAction(qc, G, { kind: "leave" }, { available: true });
    expect(out.kind).toBe("uncertain");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: gameKeys.detail(G) });
  });

  it("an ended session is signed-out and refreshes nothing", async () => {
    const qc = client();
    const spy = jest.spyOn(qc, "invalidateQueries");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "JWT expired", code: "PGRST301", status: 401 } });
    expect((await runGameAction(qc, G, { kind: "join" }, { available: true })).kind).toBe("signed-out");
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unknown error is shown once as a refusal, never as success", () => {
    expect(outcomeOf({ message: "boom", code: "XX000" }).kind).toBe("refused");
  });

  it("after success the board, club games, detail, people and Bookings are refreshed", async () => {
    const qc = client();
    const spy = jest.spyOn(qc, "invalidateQueries");
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await runGameAction(qc, G, { kind: "status", status: "cancelled" }, { available: true });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const k of [gameKeys.detail(G), gameKeys.people(G), ["games"], ["club-games"], gameKeys.agenda]) {
      expect(keys).toContain(JSON.stringify(k));
    }
  });
});

describe("one call in flight per action (U8)", () => {
  it("a second tap while the first is running sends nothing and gets the same outcome", async () => {
    const d = deferred<{ data: unknown; error: unknown }>();
    rpc.mockReturnValueOnce(d.promise);
    const qc = client();
    const first = runGameAction(qc, G, { kind: "join" }, { available: true });
    const second = runGameAction(qc, G, { kind: "join" }, { available: true });
    expect(actionBusy(G, { kind: "join" })).toBe(true);
    d.resolve({ data: "accepted", error: null });
    expect(await first).toEqual(await second);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(actionBusy(G, { kind: "join" })).toBe(false);
  });

  it("deciding two different requests is not blocked by each other", () => {
    expect(actionKey(G, { kind: "decide", profileId: "a", accept: true }))
      .not.toBe(actionKey(G, { kind: "decide", profileId: "b", accept: false }));
  });
});

describe("useGameActions", () => {
  it("passes the cached court-lost state and reports busy while running", async () => {
    const qc = client();
    qc.setQueryData(gameKeys.detail(G), { court_lost: true });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const d = deferred<{ data: unknown; error: unknown }>();
    rpc.mockReturnValueOnce(d.promise);
    const { result } = await renderHook(() => useGameActions(G, { available: true }), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.run({ kind: "join" }); });
    expect(result.current.busy({ kind: "join" })).toBe(true);
    let out: unknown;
    await act(async () => {
      d.resolve({ data: null, error: { message: "match_closed", code: "P0001" } });
      out = await pending;
    });
    expect(out).toMatchObject({ kind: "refused", failure: { message: COURT_PAUSED } });
    expect(result.current.busy({ kind: "join" })).toBe(false);
  });
});
