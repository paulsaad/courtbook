// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

let dismissAnswer: { error: { message: string } | null } | "throw" = { error: null };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      if (fn === "my_playing_prefs") return { data: { asked: false, areas: [], last: null }, error: null };
      if (fn === "dismiss_areas_question") { if (dismissAnswer === "throw") throw new Error("network"); return { data: null, ...dismissAnswer }; }
      throw new Error(fn);
    },
  }),
}));
const { usePlaying } = await import("./playing");

beforeEach(() => { dismissAnswer = { error: null }; });

describe("'Not now' on the website (M14 review C)", () => {
  it("saved: the question is marked answered", async () => {
    const { result } = renderHook(() => usePlaying(true));
    await waitFor(() => expect(result.current.prefs?.asked).toBe(false));
    await act(async () => { await result.current.dismissQuestion(); });
    expect(result.current.prefs?.asked).toBe(true);
  });
  for (const [label, answer, code] of [
    ["refused by the database (closed account)", { error: { message: "account_closed" } }, "account_closed"],
    ["any other failure", { error: { message: "JWT expired: something" } }, "failed"],
    ["network error", "throw", "failed"],
  ] as const) {
    it(`${label}: throws, and the question is NOT marked answered`, async () => {
      dismissAnswer = answer;
      const { result } = renderHook(() => usePlaying(true));
      await waitFor(() => expect(result.current.prefs?.asked).toBe(false));
      let err: unknown = null;
      await act(async () => { try { await result.current.dismissQuestion(); } catch (e) { err = e; } });
      expect((err as Error).message).toBe(code);
      expect(result.current.prefs?.asked).toBe(false);
    });
  }
});
