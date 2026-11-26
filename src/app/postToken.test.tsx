// @vitest-environment jsdom
/**
 * Review of #78 (Paul, 26 Nov): the key that makes a retried post safe (post_match p_token, 0073) was kept after a
 * network failure even when the player then changed the game. post_match answers a known key with the game already
 * made, comparing nothing else, so the changed game would never be posted. The key now belongs to the exact request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forgetRequest, requestKey, tokenForRequest } from "@/lib/requestToken";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
const args: Record<string, unknown>[] = [];
let answers: { data: unknown; error: unknown }[] = [];
const LOST = { data: null, error: { message: "TypeError: Failed to fetch" } };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (_fn: string, a: Record<string, unknown>) => { args.push(a); return answers.shift() ?? LOST; } }),
}));
import OpenToPlayers from "./bookings/[id]/OpenToPlayers";
import MatchBoard from "@/components/MatchBoard";

const OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";
const club = { id: "c1", name: "Club", slug: "c", timezone: "Asia/Beirut", open_time: "08:00", close_time: "23:00", slot_minutes: 30 };
beforeEach(() => { args.length = 0; answers = []; router.push.mockReset(); router.refresh.mockReset(); });
afterEach(cleanup);

function board() {
  const { container } = render(<MatchBoard club={club} rows={[]} myBookings={[]} sports={[{ code: "padel", name_en: "Padel" }]} />);
  fireEvent.click(screen.getByText("Post a match"));
  const form = container.querySelector("form")!;
  const note = screen.getByPlaceholderText(/Note \(optional\)/);
  const time = container.querySelector<HTMLInputElement>('input[type="time"]')!;
  return { submit: async () => { const n = args.length; fireEvent.submit(form); await waitFor(() => expect(args.length).toBe(n + 1)); await screen.findByText(OFFLINE); }, note, time };
}

describe("the post key belongs to the exact request (review of #78)", () => {
  it("rule: same request → same key; any changed argument → another key; a refusal forgets it", () => {
    const tokens = new Map<string, string>();
    let n = 0; const make = () => `t${++n}`;
    const a = { p_sport: "padel", p_note: "", p_players_needed: 3 };
    expect(tokenForRequest(tokens, a, make)).toBe("t1");
    expect(tokenForRequest(tokens, { p_players_needed: 3, p_note: "", p_sport: "padel" }, make)).toBe("t1");   // order does not matter
    expect(tokenForRequest(tokens, { ...a, p_note: "bring balls" }, make)).toBe("t2");
    expect(tokenForRequest(tokens, { ...a, p_players_needed: 2 }, make)).toBe("t3");
    expect(tokenForRequest(tokens, a, make)).toBe("t1");                                                       // back to the first: its own key
    forgetRequest(tokens, a);
    expect(tokenForRequest(tokens, a, make)).toBe("t4");
    expect(requestKey({ x: undefined })).toBe(requestKey({ x: null }));
  });

  it("Post a match: lost answer, then the note is changed → the retry carries a NEW key; unchanged → the same key", async () => {
    const b = board();
    await b.submit();                                              // lost: maybe posted
    await b.submit();                                              // same request again
    fireEvent.change(b.note, { target: { value: "friendly doubles" } });
    await b.submit();                                              // a different game
    expect(args[1].p_token).toBe(args[0].p_token);
    expect(args[2].p_note).toBe("friendly doubles");
    expect(args[2].p_token).not.toBe(args[0].p_token);
  });

  it("Post a match: lost answer, then another time → a new key; back to the first time → the first key", async () => {
    const b = board();
    await b.submit();
    const first = args[0];
    fireEvent.change(b.time, { target: { value: "20:00" } });
    await b.submit();
    expect(args[1].p_start).not.toBe(first.p_start);
    expect(args[1].p_token).not.toBe(first.p_token);
    fireEvent.change(b.time, { target: { value: "18:00" } });
    await b.submit();
    expect(args[2].p_start).toBe(first.p_start);
    expect(args[2].p_token).toBe(first.p_token);                  // the game that may exist is returned, not posted twice
  });

  it("Open to players: lost answer, then the note is changed → a new key", async () => {
    render(<OpenToPlayers bookingId="b1" sport="padel" sportName="Padel" match={null} />);
    fireEvent.click(screen.getByText("Open to other players"));
    fireEvent.click(screen.getByText("Open to players")); await screen.findByText(OFFLINE);
    fireEvent.change(screen.getByPlaceholderText(/Note \(optional\)/), { target: { value: "bring balls" } });
    fireEvent.click(screen.getByText("Open to players")); await waitFor(() => expect(args).toHaveLength(2));
    expect(args[1].p_note).toBe("bring balls");
    expect(args[1].p_token).not.toBe(args[0].p_token);
  });

  it("Open to players: a refusal forgets the key; the next try of the same request gets a new one", async () => {
    answers = [{ data: null, error: { message: "not_found" } }, LOST];
    render(<OpenToPlayers bookingId="b1" sport="padel" sportName="Padel" match={null} />);
    fireEvent.click(screen.getByText("Open to other players"));
    fireEvent.click(screen.getByText("Open to players")); await waitFor(() => expect(args).toHaveLength(1));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Open to players")); await waitFor(() => expect(args).toHaveLength(2));
    expect(args[1].p_token).not.toBe(args[0].p_token);
  });
});
