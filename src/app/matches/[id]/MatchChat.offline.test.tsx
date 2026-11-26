// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type Ev = { op: string; arg?: unknown };
let events: Ev[] = [];
let insertAnswers: { data: unknown; error: unknown }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }[]> = {};
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const router = { refresh: vi.fn(), replace: vi.fn(), push: vi.fn() };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, arg?: unknown) => {
      events.push({ op: fn, arg });
      const queued = rpcAnswers[fn]?.shift();
      if (queued) return queued;
      return { data: fn === "match_messages_list" ? null : "2026-11-20T10:00:00Z", error: null };
    },
    from: () => {
      const b: Record<string, unknown> = {};
      b.insert = (row: unknown) => { events.push({ op: "insert", arg: row }); return b; };
      b.select = () => b;
      b.single = async () => insertAnswers.shift() ?? { data: null, error: null };
      return b;
    },
  }),
}));

import MatchChat from "./MatchChat";

const props = { matchId: "m1", meId: "me", tz: "Asia/Beirut", finished: false, hidden: false };
beforeEach(() => { events = []; insertAnswers = []; rpcAnswers = {}; vi.stubGlobal("fetch", vi.fn(async () => ({}))); Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });


describe("chat Send with no connection (H3, Session B's handover)", () => {
  it.each(["TypeError: Failed to fetch", "Load failed"])("%s: says the connection failed (not 'Refresh'), announced; the text is kept", async (message) => {
    insertAnswers = [{ data: null, error: { message } }];
    render(<MatchChat {...props} initial={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "on my way" } });
    fireEvent.click(screen.getByText("Send"));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach CourtBook. Check your connection and try again.");
    expect(screen.queryByText(/Refresh/)).toBeNull();
    expect((screen.getByPlaceholderText("Message") as HTMLInputElement).value).toBe("on my way");
  });
});
