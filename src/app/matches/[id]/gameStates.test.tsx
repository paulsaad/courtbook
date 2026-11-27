// @vitest-environment jsdom
/**
 * Session B's round-4 handover (26 Nov), game page states:
 *  - H15: chat Send after leaving the game on another device said "Something went wrong. Refresh and try again."
 *  - H16: a failed delete of your own message reset the thread to the page's first copy (newer messages vanished).
 *  - H17: Accept retried after a lost answer said "Only a pending request can be approved."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { refresh: vi.fn(), replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
let insertAnswers: { data: unknown; error: unknown }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }[]> = {};
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string) => rpcAnswers[fn]?.shift() ?? { data: fn === "match_messages_list" ? null : null, error: null },
    from: () => {
      const b: Record<string, unknown> = {};
      b.insert = () => b; b.select = () => b;
      b.single = async () => insertAnswers.shift() ?? { data: null, error: null };
      return b;
    },
  }),
}));
import MatchChat, { NOT_IN_GAME } from "./MatchChat";
import MatchActions from "./MatchActions";
import type { MatchRow } from "@/components/MatchBoard";

const props = { matchId: "m1", meId: "me", tz: "Asia/Beirut", finished: false, hidden: false };
const mine = { id: "a1", profile_id: "me", name: "You", body: "see you at 7", created_at: "2026-11-26T12:00:00Z" };
const karim = { id: "k1", profile_id: "karim", name: "Karim", body: "bringing balls", created_at: "2026-11-26T12:01:00Z" };
beforeEach(() => { insertAnswers = []; rpcAnswers = {}; router.refresh.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => ({}))); Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("H15: Send after leaving the game elsewhere", () => {
  it("says 'You're no longer in this game.', keeps the text, and refreshes the page", async () => {
    insertAnswers = [{ data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "match_messages"' } }];
    render(<MatchChat {...props} initial={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "on my way" } });
    fireEvent.click(screen.getByText("Send"));
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_IN_GAME);
    expect((screen.getByPlaceholderText("Message") as HTMLInputElement).value).toBe("on my way");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
  it("other refusals are unchanged and do not refresh", async () => {
    insertAnswers = [{ data: null, error: { code: "P0001", message: "slow_down" } }];
    render(<MatchChat {...props} initial={[]} />);
    fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Send"));
    expect((await screen.findByRole("alert")).textContent).toBe("You're sending messages quickly. Wait a moment.");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("H16: deleting your own message fails", () => {
  it("only that message comes back; a newer message from polling stays; the reason is shown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    rpcAnswers.match_messages_list = [{ data: [mine, karim], error: null }];
    render(<MatchChat {...props} initial={[mine]} />);
    await act(async () => { vi.advanceTimersByTime(5000); });
    await screen.findByText("bringing balls");
    rpcAnswers.delete_match_message = [{ data: null, error: { message: "TypeError: Failed to fetch" } }];
    fireEvent.click(screen.getByText("Delete"));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach CourtBook. Check your connection and try again.");
    expect(screen.getByText("bringing balls")).toBeTruthy();
    expect(screen.getByText("see you at 7")).toBeTruthy();
  });
  it("a successful delete shows 'Message deleted' and no error", async () => {
    render(<MatchChat {...props} initial={[mine]} />);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(screen.queryByText("see you at 7")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("H17: Accept on a request that was already answered", () => {
  const m = {
    match_id: "m1", club_id: "c1", club_name: "Club", club_slug: "c", sport: "padel", start_at: "2026-12-01T16:00:00Z", end_at: null,
    level_min: null, level_max: null, level_legacy: false, my_level: null, players_needed: 3, joined: 1, pending: 1, status: "open", closed_reason: null,
    note: null, join_mode: "approval", organizer_id: "me", organizer_name: "Rana", my_status: "accepted", i_organize: true, booking_id: null, court_name: null,
  } as MatchRow;
  const sami = { profile_id: "s1", name: "Sami", level: 4, level_legacy: null, is_organizer: false, status: "pending" };
  it.each([true, false])("accept=%s: 'That request is no longer pending.', and the page refreshes to show the result", async (accept) => {
    rpcAnswers.decide_join = [{ data: null, error: { message: "not_pending", code: "P0001" } }];
    render(<MatchActions m={m} participants={[sami]} />);
    fireEvent.click(screen.getByText(accept ? "Accept" : "Decline"));
    expect((await screen.findByRole("alert")).textContent).toBe("That request is no longer pending.");
    expect(router.refresh).toHaveBeenCalled();
  });
});
