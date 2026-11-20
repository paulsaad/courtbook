// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { COMMUNITY_RULES } from "@/lib/types";

type Ev = { op: string; arg?: unknown };
let events: Ev[] = [];
let insertAnswers: { data: unknown; error: unknown }[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string) => { events.push({ op: fn }); return { data: fn === "match_messages_list" ? null : "2026-11-20T10:00:00Z", error: null }; },
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
beforeEach(() => { events = []; insertAnswers = []; vi.stubGlobal("fetch", vi.fn(async () => ({}))); Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("web chat with M3-S", () => {
  it("a blocked sender's message is withheld", () => {
    render(<MatchChat {...props} initial={[{ id: "a", profile_id: "x", name: "Sami", body: "", created_at: "2026-11-20T10:00:00Z", blocked: true }]} />);
    expect(screen.getByText("Message from a player you blocked")).toBeTruthy();
    expect(screen.queryByText("Sami")).toBeNull();
  });

  it("asks for the rules once, then sends the same message", async () => {
    insertAnswers = [
      { data: null, error: { message: "rules_not_accepted" } },
      { data: { id: "n1", profile_id: "me", body: "hello", created_at: "2026-11-20T10:01:00Z" }, error: null },
    ];
    render(<MatchChat {...props} initial={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    const dialog = await screen.findByRole("dialog", { name: "Community rules" });
    for (const r of COMMUNITY_RULES) expect(dialog.textContent).toContain(r);
    expect((screen.getByPlaceholderText("Message") as HTMLInputElement).value).toBe("hello");
    fireEvent.click(screen.getByText("I agree"));
    await screen.findByText("hello");
    expect(events.map((e) => e.op)).toEqual(["insert", "accept_community_rules", "insert"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("other refusals are shown and the text is kept", async () => {
    insertAnswers = [{ data: null, error: { message: "account_suspended" } }];
    render(<MatchChat {...props} initial={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText(/Your account is suspended/)).toBeTruthy();
    expect((screen.getByPlaceholderText("Message") as HTMLInputElement).value).toBe("hi");
    await waitFor(() => expect(events.map((e) => e.op)).toEqual(["insert"]));
  });
});
