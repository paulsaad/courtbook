// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

let server: string[] = [];
let failNext: { message: string } | null = null;
let missing = false;
const calls: Array<[string, unknown]> = [];
let release: (() => void) | null = null;
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (missing) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
      if (fn === "my_favourite_clubs") return { data: server.map((id, i) => ({ club_id: id, created_at: `2026-11-2${i}`, name: id, slug: id, town: null })), error: null };
      if (fn === "set_club_favourite") {
        if (release) await new Promise<void>((r) => { const prev = release!; release = () => { prev(); r(); }; });
        if (failNext) { const e = failNext; failNext = null; return { data: null, error: e }; }
        const id = args!.p_club as string;
        server = args!.p_favourite ? [...new Set([id, ...server])] : server.filter((x) => x !== id);
        return { data: args!.p_favourite, error: null };
      }
      throw new Error(fn);
    },
  }),
}));
const { useFavourites, toggleFavourite, resetFavouritesForTests } = await import("./favourites");

beforeEach(() => { server = ["a"]; failNext = null; missing = false; calls.length = 0; release = null; resetFavouritesForTests(); });

describe("website favourites store (0087)", () => {
  it("loads once when signed in; nothing when signed out", async () => {
    renderHook(() => useFavourites(false));
    expect(calls).toEqual([]);
    const { result } = renderHook(() => useFavourites(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect([...result.current.ids]).toEqual(["a"]);
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
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
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
