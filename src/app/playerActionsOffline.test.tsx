// @vitest-environment jsdom
/**
 * Website player actions with no connection (local pilot build, 360 px, 26 Nov): Join, Leave, sending
 * "Open to players", "Post a match" and saving a level all said "Something went wrong. Refresh and try
 * again." A refresh with no connection replaces the page with the browser's offline page. Now they say the
 * connection failed, the page stays as it is, and the error is announced (role="alert").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
let answer: { data: unknown; error: unknown } = { data: null, error: null };
const calls: string[] = [];
const args: Record<string, unknown>[] = [];
let answers: { data: unknown; error: unknown }[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (fn: string, a: Record<string, unknown>) => { calls.push(fn); args.push(a); return answers.shift() ?? answer; } }),
}));

import MatchActions from "./matches/[id]/MatchActions";
import OpenToPlayers from "./bookings/[id]/OpenToPlayers";
import MatchBoard, { type MatchRow } from "@/components/MatchBoard";
import LevelSheet from "@/components/LevelSheet";

const OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";
const m: MatchRow = {
  match_id: "m1", club_id: "c1", club_name: "Club", club_slug: "c", sport: "padel", start_at: "2026-12-01T16:00:00Z", end_at: null,
  level_min: null, level_max: null, level_legacy: false, my_level: null, players_needed: 3, joined: 1, pending: 0, status: "open", closed_reason: null,
  note: null, join_mode: "open", organizer_id: "o", organizer_name: "Karim", my_status: null, i_organize: false, booking_id: null, court_name: null,
};
beforeEach(() => { answer = { data: null, error: { message: "TypeError: Failed to fetch" } }; calls.length = 0; args.length = 0; answers = []; router.push.mockReset(); router.refresh.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => ({}))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const club = { id: "c1", name: "Club", slug: "c", timezone: "Asia/Beirut", open_time: "08:00", close_time: "23:00", slot_minutes: 30 };

describe("posting a game: one key per post, so a retry cannot post it twice", () => {
  // local database, 26 Nov: two post_match calls without a key (as the website sent them) made two identical games
  it("Post a match: the retry after a lost answer sends the same key; after a refusal a new one", async () => {
    answers = [
      { data: null, error: { message: "TypeError: Failed to fetch" } },
      { data: null, error: { message: "slot_in_past" } },
      { data: "m9", error: null },
    ];
    const { container } = render(<MatchBoard club={club} rows={[]} myBookings={[]} sports={[{ code: "padel", name_en: "Padel" }]} />);
    fireEvent.click(screen.getByText("Post a match"));
    const form = container.querySelector("form")!;
    fireEvent.submit(form); await screen.findByText(OFFLINE);
    fireEvent.submit(form); await screen.findByText(/past|passed/i);
    fireEvent.submit(form); await waitFor(() => expect(router.push).toHaveBeenCalledWith("/matches/m9"));
    const keys = args.map((a) => a.p_token);
    expect(typeof keys[0]).toBe("string");
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("Open to players: the retry sends the same key", async () => {
    answers = [{ data: null, error: { message: "Load failed" } }, { data: "m9", error: null }];
    render(<OpenToPlayers bookingId="b1" sport="padel" sportName="Padel" match={null} />);
    fireEvent.click(screen.getByText("Open to other players"));
    fireEvent.click(screen.getByText("Open to players")); await screen.findByText(OFFLINE);
    fireEvent.click(screen.getByText("Open to players")); await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(args[1].p_token).toBe(args[0].p_token);
    expect(typeof args[0].p_token).toBe("string");
  });
});

describe("player actions with no connection", () => {
  it("Join", async () => {
    render(<MatchActions m={m} participants={[]} />);
    fireEvent.click(screen.getByText("Join"));
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(calls).toEqual(["join_match"]);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByText("Join")).toBeTruthy();   // still there to try again
  });

  it("Leave", async () => {
    render(<MatchActions m={{ ...m, my_status: "accepted" }} participants={[]} />);
    fireEvent.click(screen.getByText("Leave"));
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("a server refusal keeps the shared wording", async () => {
    answer = { data: null, error: { message: "match_full" } };
    render(<MatchActions m={m} participants={[]} />);
    fireEvent.click(screen.getByText("Join"));
    expect((await screen.findByRole("alert")).textContent).not.toBe(OFFLINE);
  });

  it("Open to players on a booking", async () => {
    render(<OpenToPlayers bookingId="b1" sport="padel" sportName="Padel" match={null} />);
    fireEvent.click(screen.getByText("Open to other players"));
    fireEvent.click(screen.getByText("Open to players"));
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(calls).toEqual(["post_match"]);
    expect(screen.getByText("Open to players")).toBeTruthy();   // the form stays filled in
  });

  it("Post a match", async () => {
    const { container } = render(<MatchBoard club={club} rows={[]} myBookings={[]} sports={[{ code: "padel", name_en: "Padel" }]} />);
    fireEvent.click(screen.getByText("Post a match"));
    fireEvent.submit(container.querySelector("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Save a level", async () => {
    const onSaved = vi.fn();
    render(<LevelSheet sport="padel" sportName="Padel" current={3} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getAllByRole("radio")[4]);   // level 5
    fireEvent.click(screen.getByText("Save level"));
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
