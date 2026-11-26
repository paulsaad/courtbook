// @vitest-environment jsdom
/**
 * Website booking with no connection (26 Nov, local pilot build at 360 px): "Reserve" while offline replaced the
 * club page with the browser's offline page. The failure itself was handled, but the follow-up router.refresh()
 * could not reach the server either, and Next.js fell back to a full page load. Now the panel says the phone is
 * offline, the selection stays, and a second tap retries with the same token (one court at most).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
let bookAnswers: { data: unknown; error: unknown }[] = [];
const bookCalls: Record<string, unknown>[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    // a signed-in player whose name and contact phone are complete (so #73's details check, when present, passes)
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "book_at_desk") return { data: 20, error: null };   // the price quote
      bookCalls.push(args);
      return bookAnswers.shift() ?? { data: [{ booking_id: "b1" }], error: null };
    },
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b; b.maybeSingle = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null }); b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return b; },
  }),
}));

import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const club = {
  id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false,
} as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;

async function reserveButton() {
  render(<PlayerGrid signedIn club={club} courts={COURTS} occ={[]} occError={false} date={tomorrow} hold={null}
    preselect={{ date: tomorrow, time: "10:00", courtId: "k1", minutes: 60 }} sportNames={{ padel: "Padel" }} />);
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(within(dialog).getByText("$20.00", { exact: false })).toBeTruthy());
  return within(dialog).getByRole("button", { name: /Reserve/ });
}

Element.prototype.scrollIntoView = function () {};
beforeEach(() => { bookAnswers = []; bookCalls.length = 0; router.push.mockReset(); router.refresh.mockReset(); });
afterEach(cleanup);

describe("club page: reserving with no connection", () => {
  it("says so, keeps the page and the selection, and does not refresh", async () => {
    bookAnswers = [{ data: null, error: { message: "TypeError: Failed to fetch", code: "" } }];
    fireEvent.click(await reserveButton());
    expect(await screen.findByText("Couldn't reach CourtBook. Check your connection and try again.")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("10:00–11:00");
  });

  it("the retry uses the same token, then opens the booking", async () => {
    bookAnswers = [{ data: null, error: { message: "Load failed" } }];
    const button = await reserveButton();
    fireEvent.click(button);
    await screen.findByText(/Couldn't reach CourtBook/);
    fireEvent.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/bookings/b1?new=1"));
    expect(bookCalls).toHaveLength(2);
    expect(bookCalls[1].p_token).toBe(bookCalls[0].p_token);
  });

  it("a refusal from the server still refreshes the grid (the slot was taken)", async () => {
    bookAnswers = [{ data: null, error: { message: "slot_taken", code: "P0001" } }];
    fireEvent.click(await reserveButton());
    expect(await screen.findByText("That slot was just taken.")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
