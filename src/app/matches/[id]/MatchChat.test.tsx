// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { COMMUNITY_RULES } from "@/lib/types";

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

import MatchChat from "./MatchChat";

const props = { matchId: "m1", meId: "me", tz: "Asia/Beirut", finished: false, hidden: false };
beforeEach(() => { events = []; insertAnswers = []; rpcAnswers = {}; vi.stubGlobal("fetch", vi.fn(async () => ({}))); Element.prototype.scrollIntoView = () => {}; });
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

// ---- report and block (website, as the app) ------------------------------------------------------
const sami = { id: "s1", profile_id: "sami", name: "Sami", body: "rude words", created_at: "2026-11-20T10:00:00Z" };
const mine = { id: "m1", profile_id: "me", name: "You", body: "my own", created_at: "2026-11-20T10:01:00Z" };
const gone = { id: "d1", profile_id: "lea", name: null, body: "", created_at: "2026-11-20T10:02:00Z", deleted: true };
const hush = { id: "b1", profile_id: "karim", name: "Karim", body: "", created_at: "2026-11-20T10:03:00Z", blocked: true };
const ops = () => events.map((e) => e.op);

describe("web chat: report and block", () => {
  it("options only on other players' visible messages", () => {
    render(<MatchChat {...props} initial={[sami, mine, gone, hush]} />);
    const options = screen.getAllByRole("button", { name: /^Options for/ });
    expect(options.map((b) => b.getAttribute("aria-label"))).toEqual(["Options for Sami's message"]);
  });

  it("report: a reason is required, then the report goes with the message id and the thanks is shown", async () => {
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Report message"));
    const sheet = screen.getByRole("dialog", { name: "Report message" });
    const send = within(sheet).getByText("Send report") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(sheet).getByLabelText("Threat or danger"));
    fireEvent.change(within(sheet).getByLabelText(/Anything else/), { target: { value: " he threatened me " } });
    fireEvent.click(send);
    const done = await screen.findByRole("dialog", { name: "Report sent" });
    expect(done.textContent).toContain("Thanks for reporting this.");
    expect(done.textContent).toContain("If anyone is in danger, contact the police or emergency services now.");
    expect(events).toEqual([{ op: "report_content", arg: { p_kind: "message", p_target: "s1", p_reason: "danger", p_note: "he threatened me" } }]);
  });

  it("a refused report is explained, the sheet stays open and the choice is kept", async () => {
    rpcAnswers.report_content = [{ data: null, error: { message: "TypeError: Failed to fetch" } }];
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Report message"));
    fireEvent.click(screen.getByLabelText("Spam"));
    fireEvent.click(screen.getByText("Send report"));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach CourtBook. Check your connection and try again.");
    expect((screen.getByLabelText("Spam") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText("Send report"));
    await screen.findByRole("dialog", { name: "Report sent" });
  });

  it("block: asks first, blocks the sender, reloads the thread and the message is withheld", async () => {
    rpcAnswers.match_messages_list = [{ data: [{ ...sami, body: "", blocked: true }], error: null }];
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Block Sami"));
    const ask = screen.getByRole("alertdialog", { name: "Block Sami?" });
    expect(ask.textContent).toContain("They aren't told.");
    expect(ask.textContent).toContain("You can unblock them in Blocked players.");
    expect(within(ask).getByRole("link", { name: "Blocked players" }).getAttribute("href")).toBe("/profile/blocked");
    expect(ops()).toEqual([]);   // nothing happens before the confirmation
    fireEvent.click(within(ask).getByText("Block"));
    expect(await screen.findByText(/You blocked Sami\. You won't see their messages\./)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(events[0]).toEqual({ op: "block_player", arg: { p_profile: "sami" } });
    expect(ops()).toEqual(["block_player", "match_messages_list"]);
    expect(screen.queryByText("rude words")).toBeNull();
    expect(screen.getByText(/Message from a player you blocked/)).toBeTruthy();
  });

  it("cancel blocks nobody", () => {
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Block Sami"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ops()).toEqual([]);
  });

  it("a refused block (signed out) is explained inside the dialog; nothing reloads", async () => {
    rpcAnswers.block_player = [{ data: null, error: { message: "not_authenticated" } }];
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Block Sami"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByText("Block"));
    expect((await screen.findByRole("alert")).textContent).toBe("Your session has ended. Sign in again.");
    expect(screen.getByRole("alertdialog", { name: "Block Sami?" })).toBeTruthy();
    expect(ops()).toEqual(["block_player"]);
    expect(screen.getByText("rude words")).toBeTruthy();
  });

  it("after a report, 'Block' leads to the same confirmation", async () => {
    render(<MatchChat {...props} initial={[sami]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Report message"));
    fireEvent.click(screen.getByLabelText("Spam"));
    fireEvent.click(screen.getByText("Send report"));
    const done = await screen.findByRole("dialog", { name: "Report sent" });
    fireEvent.click(within(done).getByText("Block Sami"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Block Sami?" })).toBeTruthy();
  });

  it("an open options menu closes when polling shows the message deleted or withheld", async () => {
    vi.useFakeTimers();
    try {
      const karim = { id: "k1", profile_id: "karim", name: "Karim", body: "see you", created_at: "2026-11-20T10:04:00Z" };
      rpcAnswers.match_messages_list = [
        { data: [{ ...sami, body: "", deleted: true }, karim], error: null },
        { data: [{ ...sami, body: "", deleted: true }, { ...karim, body: "", blocked: true }], error: null },
        { data: [{ ...sami, body: "", deleted: true }, karim], error: null },
      ];
      render(<MatchChat {...props} initial={[sami, karim]} />);
      fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
      expect(screen.getByText("Report message")).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(5000));   // poll: Sami deleted it
      expect(screen.queryByRole("group", { name: "Message options" })).toBeNull();
      expect(screen.getByText("Message deleted")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Options for Karim's message" }));
      expect(screen.getByText("Block Karim")).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(5000));   // poll: Karim is now withheld (blocked from another device)
      expect(screen.queryByRole("group", { name: "Message options" })).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(5000));   // poll: visible again; the menu does not reopen by itself
      expect(screen.getByText("see you")).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Message options" })).toBeNull();
      expect(ops()).not.toContain("report_content");
      expect(ops()).not.toContain("block_player");
    } finally { vi.useRealTimers(); }
  });

  it("no private details: a message row carrying contact fields shows only the name and the text", () => {
    const leaky = { ...sami, phone: "+96170123456", email: "sami@example.com" } as typeof sami;
    const { container } = render(<MatchChat {...props} initial={[leaky]} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Sami's message" }));
    fireEvent.click(screen.getByText("Report message"));
    expect(container.ownerDocument.body.textContent).not.toMatch(/96170123456|sami@example\.com/);
  });
});

describe("web chat on a 360 px phone", () => {
  it("the message box may shrink, so Send stays on screen (it was 260 px wide and pushed the page sideways)", () => {
    render(<MatchChat {...props} initial={[]} />);
    expect(screen.getByRole("textbox", { name: "Message" }).className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
  });
});
