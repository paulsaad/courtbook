// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// One server list per account; each call answers for the account signed in WHEN IT WAS SENT (its token).
let servers: Record<string, string[]> = {};
let uid: string | null = "A";
let failNext: { message: string } | null = null;
let missing = false;
const calls: Array<[string, unknown, string | null]> = [];
let release: (() => void) | null = null;
/** Hold the next list read(s) until the returned function is called. */
const holds: Array<() => void> = [];
let holdLists = 0;
type AuthCb = (e: string, s: { user: { id: string } } | null) => void;
let authCbs: AuthCb[] = [];
const signIn = (id: string | null) => { uid = id; authCbs.forEach((cb) => cb(id ? "SIGNED_IN" : "SIGNED_OUT", id ? { user: { id } } : null)); };

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null }, error: null }),
      onAuthStateChange: (cb: AuthCb) => { authCbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      const who = uid;
      calls.push([fn, args, who]);
      if (missing) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
      if (!who) return { data: null, error: { message: "not_authenticated" } };
      if (fn === "my_favourite_clubs") {
        const snapshot = [...(servers[who] ?? [])];
        if (holdLists > 0) { holdLists--; await new Promise<void>((r) => holds.push(r)); }
        return { data: snapshot.map((id, i) => ({ club_id: id, created_at: `2026-11-2${i}`, name: id, slug: id, town: null })), error: null };
      }
      if (fn === "set_club_favourite") {
        if (release) await new Promise<void>((r) => { const prev = release!; release = () => { prev(); r(); }; });
        if (failNext) { const e = failNext; failNext = null; return { data: null, error: e }; }
        const id = args!.p_club as string;
        const list = servers[who] ?? [];
        servers[who] = args!.p_favourite ? [...new Set([id, ...list])] : list.filter((x) => x !== id);
        return { data: args!.p_favourite, error: null };
      }
      throw new Error(fn);
    },
  }),
}));
const { useFavourites, toggleFavourite, resetFavouritesForTests } = await import("./favourites");
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  servers = { A: ["a"], B: ["x", "y"] }; uid = "A"; failNext = null; missing = false; calls.length = 0; release = null;
  holds.length = 0; holdLists = 0; authCbs = []; resetFavouritesForTests();
});

describe("website favourites store (0087)", () => {
  it("loads once when signed in; nothing when signed out", async () => {
    renderHook(() => useFavourites(false));
    expect(calls).toEqual([]);
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect([...result.current.ids]).toEqual(["a"]);
  });
  it("many hearts on one page: one list read", async () => {
    const hooks = [1, 2, 3, 4].map(() => renderHook(() => useFavourites(true)));
    await waitFor(() => expect(hooks[0].result.current.status).toBe("ready"));
    expect(calls.filter(([fn]) => fn === "my_favourite_clubs")).toHaveLength(1);
  });
  it("before 0087 (function missing): unavailable, so no heart is drawn", async () => {
    missing = true;
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });
  it("a tap shows at once and ends equal to the server", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let p!: Promise<void>;
    act(() => { p = toggleFavourite("b", true); });
    expect(result.current.ids.has("b")).toBe(true);
    await act(async () => { await p; });
    await waitFor(() => expect(result.current.clubs.map((c) => c.club_id)).toEqual(["b", "a"]));
  });
  it("a refusal puts the heart back and says why (cap of 50)", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    failNext = { message: "too_many_favourites" };
    await act(async () => { await toggleFavourite("b", true); });
    expect(result.current.ids.has("b")).toBe(false);
    expect(result.current.message).toMatch(/up to 50/);
  });
  it("a list read during another club's save does not undo that save", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    release = () => {};
    act(() => { void toggleFavourite("c", true); });           // its save never answers in this test
    await tick();
    release = null;
    await act(async () => { await toggleFavourite("b", true); });   // finishes first and reloads the list (no "c" on the server yet)
    expect(result.current.ids.has("c")).toBe(true);                // still shown: it is pending
  });
  it("one save per club at a time", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const p1 = toggleFavourite("b", true);
    const p2 = toggleFavourite("b", false);
    await act(async () => { await Promise.all([p1, p2]); });
    expect(calls.filter(([fn]) => fn === "set_club_favourite")).toHaveLength(1);
  });
});

describe("account isolation (M14 review A)", () => {
  it("switching accounts: the previous list disappears at once and only the new account's loads", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect([...result.current.ids]).toEqual(["a"]));
    const seen: string[][] = [];
    act(() => { signIn("B"); });
    seen.push([...result.current.ids]);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    seen.push([...result.current.ids]);
    expect(seen[0]).toEqual([]);                       // nothing of A's shown while B loads
    expect(seen[1].sort()).toEqual(["x", "y"]);
    expect(result.current.clubs.map((c) => c.club_id)).not.toContain("a");
  });
  it("soft sign-in as another account without an auth event (another tab): the next load notices and starts clean", async () => {
    const { result, rerender } = renderHook(({ s }) => useFavourites(s), { initialProps: { s: true } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    uid = "B";                                          // the cookie changed; no event in this tab
    await act(async () => { await toggleFavourite("z", true); });   // saved as B (the request carries B's token), then reloads
    await waitFor(() => expect(result.current.clubs.map((c) => c.club_id).sort()).toEqual(["x", "y", "z"]));
    expect(result.current.ids.has("a")).toBe(false);
    rerender({ s: true });
  });
  it("a delayed list from the previous account is dropped", async () => {
    holdLists = 1;                                      // A's first list read is slow
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(holds).toHaveLength(1));
    act(() => { signIn("B"); });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect([...result.current.ids].sort()).toEqual(["x", "y"]);
    await act(async () => { holds[0](); await new Promise((r) => setTimeout(r, 0)); });   // A's answer arrives late
    expect([...result.current.ids].sort()).toEqual(["x", "y"]);
    expect(result.current.clubs.map((c) => c.club_id)).not.toContain("a");
  });
  it("an older list read of the same account cannot overwrite a newer one", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    holdLists = 1;                                      // the reload after the first save is slow…
    await act(async () => { await toggleFavourite("b", true); });
    await waitFor(() => expect(holds).toHaveLength(1));
    await act(async () => { await toggleFavourite("c", true); });   // …the second save's reload answers first
    await waitFor(() => expect(result.current.clubs.map((c) => c.club_id).sort()).toEqual(["a", "b", "c"]));
    await act(async () => { holds[0](); await new Promise((r) => setTimeout(r, 0)); });   // the stale list (no "c") arrives
    expect(result.current.ids.has("c")).toBe(true);
    expect(result.current.clubs.map((c) => c.club_id).sort()).toEqual(["a", "b", "c"]);
  });
  it("a save still in flight when the account changes does not touch the new account's hearts or messages", async () => {
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    release = () => {};
    failNext = { message: "too_many_favourites" };
    let p!: Promise<void>;
    act(() => { p = toggleFavourite("b", true); });
    expect(result.current.ids.has("b")).toBe(true);
    act(() => { signIn("B"); });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => { release!(); await p; });
    expect(result.current.ids.has("b")).toBe(false);
    expect(result.current.message).toBeNull();
    expect(result.current.saving.size).toBe(0);
    expect([...result.current.ids].sort()).toEqual(["x", "y"]);
  });
  it("sign-out: nothing shown, and a tap does nothing", async () => {
    const { result, rerender } = renderHook(({ s }) => useFavourites(s), { initialProps: { s: true } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => { signIn(null); });
    rerender({ s: false });
    expect(result.current.ids.size).toBe(0);
    expect(result.current.clubs).toEqual([]);
    const before = calls.length;
    await act(async () => { await toggleFavourite("a", false); });
    expect(calls.length).toBe(before);
    // signing back in as A shows A's list again (from the server, not a cache)
    act(() => { signIn("A"); });
    rerender({ s: true });
    await waitFor(() => expect([...result.current.ids]).toEqual(["a"]));
  });
});
