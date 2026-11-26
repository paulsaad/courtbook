// @vitest-environment jsdom
/** The Courts page's booking sheet with no connection: as the club page (PlayerGrid.offline.test.tsx). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
let bookAnswers: { data: unknown; error: unknown }[] = [];
const bookCalls: Record<string, unknown>[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "book_at_desk") return { data: 20, error: null };
      bookCalls.push(args);
      return bookAnswers.shift() ?? { data: [{ booking_id: "b1" }], error: null };
    },
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq"]) b[m] = () => b; b.single = async () => ({ data: { payment_mode: "at_desk" }, error: null }); return b; },
  }),
}));
import BookSheet from "./BookSheet";

const club = { id: "c1", name: "Test Club", slug: "test", slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut" };
async function reserveButton() {
  render(<BookSheet club={club} date="2026-12-01" at="2026-12-01T08:00:00Z" courts={[{ id: "k1", name: "Court 1", free: 120 }]} initialCourtId="k1" initialMinutes={60} signedIn onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /Reserve/ }).textContent).toContain("you pay at the club"));
  await waitFor(() => expect(document.body.textContent).toContain("$20.00"));
  return screen.getByRole("button", { name: /Reserve/ });
}
beforeEach(() => { bookAnswers = []; bookCalls.length = 0; router.push.mockReset(); router.refresh.mockReset(); });
afterEach(cleanup);

describe("Courts booking sheet: reserving with no connection", () => {
  it("says so, does not refresh, and the retry uses the same token", async () => {
    bookAnswers = [{ data: null, error: { message: "TypeError: NetworkError when attempting to fetch resource." } }];
    const button = await reserveButton();
    fireEvent.click(button);
    expect(await screen.findByText("Couldn't reach CourtBook. Check your connection and try again.")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/bookings/b1?new=1"));
    expect(bookCalls[1].p_token).toBe(bookCalls[0].p_token);
  });
  it("a server refusal still refreshes", async () => {
    bookAnswers = [{ data: null, error: { message: "slot_taken" } }];
    fireEvent.click(await reserveButton());
    await screen.findByText("That slot was just taken.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
