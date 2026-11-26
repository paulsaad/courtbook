// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// H13 (Session B's round-4 handover): a chat message whose answer was lost must not be created twice
// when Send is tapped again. The id is made in the browser and reused for that message's retries.

type Ev = { op: string; arg?: unknown };
let events: Ev[] = [];
let insertAnswers: { data: unknown; error: unknown }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }[]> = {};
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

import MatchChat, { NOT_CONFIRMED } from "./MatchChat";

const props = { matchId: "m1", meId: "me", tz: "Asia/Beirut", finished: false, hidden: false };
const box = () => screen.getByPlaceholderText("Message") as HTMLInputElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
const tapSend = () => fireEvent.click(screen.getByText("Send"));
const inserts = () => events.filter((e) => e.op === "insert").map((e) => e.arg as { id: string; body: string });
const lost = { data: null, error: { message: "TypeError: Failed to fetch" } };
const row = (id: string, body: string) => ({ id, profile_id: "me", name: "Rana", body, created_at: "2026-11-26T12:00:00Z", deleted: false });

let n = 0;
beforeEach(() => {
  events = []; insertAnswers = []; rpcAnswers = {}; n = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({})));
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-00000000000${++n}` as `${string}-${string}-${string}-${string}-${string}`);
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chat Send after a lost answer (H13)", () => {
  it("the retry sends the same id; the database's duplicate refusal counts as sent: one message, box cleared, no error", async () => {
    insertAnswers = [lost, { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "match_messages_pkey"' } }];
    render(<MatchChat {...props} initial={[]} />);
    type("See you at 7, bringing balls");
    tapSend();
    await screen.findByRole("alert");
    // the first try did arrive: the thread read after the refusal shows it once
    rpcAnswers.match_messages_list = [{ data: [row("00000000-0000-4000-8000-000000000001", "See you at 7, bringing balls")], error: null }];
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]);
    expect(screen.getAllByText("See you at 7, bringing balls")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an unrelated unique-constraint refusal (23505) is never a false success: text kept, 'not sent', same id next time", async () => {
    insertAnswers = [{ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "some_other_key"' } }];
    render(<MatchChat {...props} initial={[]} />);
    type("bringing water");
    rpcAnswers.match_messages_list = [{ data: [row("00000000-0000-4000-8000-000000000099", "something else")], error: null }];
    tapSend();
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_CONFIRMED);
    expect(box().value).toBe("bringing water");
    expect(screen.queryAllByText("bringing water")).toHaveLength(0);   // not shown as a message
    expect(fetch).not.toHaveBeenCalled();   // no notice email poke for a message that wasn't sent
    insertAnswers = [{ data: row("00000000-0000-4000-8000-000000000001", "bringing water"), error: null }];
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]);
  });

  it.each([
    ["another sender", { profile_id: "karim", body: "bringing water" }],
    ["different text", { profile_id: "me", body: "bringing juice" }],
    ["a deleted message", { profile_id: "me", body: "", deleted: true }],
  ])("23505 where the id holds %s: not sent, text kept; the next try uses a new id", async (_name, other) => {
    insertAnswers = [{ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "match_messages_pkey"' } }];
    rpcAnswers.match_messages_list = [{ data: [{ ...row("00000000-0000-4000-8000-000000000001", ""), ...other }], error: null }];
    render(<MatchChat {...props} initial={[]} />);
    type("bringing water");
    tapSend();
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_CONFIRMED);
    expect(box().value).toBe("bringing water");
    insertAnswers = [{ data: row("00000000-0000-4000-8000-000000000002", "bringing water"), error: null }];
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id.slice(-1))).toEqual(["1", "2"]);
  });

  it("23505 while the thread can't be read is not proof: text kept, same id next time", async () => {
    insertAnswers = [lost, { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "match_messages_pkey"' } }];
    render(<MatchChat {...props} initial={[]} />);
    type("bringing water");
    tapSend();
    await screen.findByRole("alert");
    rpcAnswers.match_messages_list = [{ data: null, error: { message: "TypeError: Failed to fetch" } }];
    tapSend();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(NOT_CONFIRMED));
    expect(box().value).toBe("bringing water");
    rpcAnswers.match_messages_list = [{ data: [row("00000000-0000-4000-8000-000000000001", "bringing water")], error: null }];
    insertAnswers = [{ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "match_messages_pkey"' } }];
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(new Set(inserts().map((r) => r.id)).size).toBe(1);
    expect(screen.getAllByText("bringing water")).toHaveLength(1);
  });

  it("a retry refused for another reason (slow_down) while the first try did arrive: shown as sent, not 'sending quickly'", async () => {
    insertAnswers = [lost, { data: null, error: { code: "P0001", message: "slow_down" } }];
    render(<MatchChat {...props} initial={[]} />);
    type("on my way");
    tapSend();
    await screen.findByRole("alert");
    rpcAnswers.match_messages_list = [{ data: [row("00000000-0000-4000-8000-000000000001", "on my way")], error: null }];
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.getAllByText("on my way")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refusal for a message that did not arrive is shown, and the text and its id are kept for the next try", async () => {
    insertAnswers = [{ data: null, error: { code: "P0001", message: "slow_down" } }, { data: row("00000000-0000-4000-8000-000000000001", "later"), error: null }];
    render(<MatchChat {...props} initial={[]} />);
    type("later");
    tapSend();
    expect((await screen.findByRole("alert")).textContent).toBe("You're sending messages quickly. Wait a moment.");
    expect(box().value).toBe("later");
    tapSend();
    await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]);
  });

  it("each sent message gets its own id, even with the same text; editing the text after a failure is a new message", async () => {
    insertAnswers = [
      { data: row("00000000-0000-4000-8000-000000000001", "ok"), error: null },
      { data: row("00000000-0000-4000-8000-000000000002", "ok"), error: null },
      lost,
      { data: row("00000000-0000-4000-8000-000000000004", "ok!"), error: null },
    ];
    render(<MatchChat {...props} initial={[]} />);
    type("ok"); tapSend(); await waitFor(() => expect(box().value).toBe(""));
    type("ok"); tapSend(); await waitFor(() => expect(box().value).toBe(""));
    type("ok"); tapSend(); await screen.findByRole("alert");
    type("ok!"); tapSend(); await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id.slice(-1))).toEqual(["1", "2", "3", "4"]);
    expect(inserts().every((r) => typeof r.id === "string")).toBe(true);
  });

  it("the community rules step sends the same message with the same id afterwards", async () => {
    insertAnswers = [{ data: null, error: { code: "P0001", message: "rules_not_accepted" } }, { data: row("00000000-0000-4000-8000-000000000001", "hi all"), error: null }];
    render(<MatchChat {...props} initial={[]} />);
    type("hi all");
    tapSend();
    fireEvent.click(await screen.findByText("I agree"));
    await waitFor(() => expect(box().value).toBe(""));
    expect(inserts().map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]);
    expect(events.filter((e) => e.op === "match_messages_list")).toHaveLength(0);
  });
});
