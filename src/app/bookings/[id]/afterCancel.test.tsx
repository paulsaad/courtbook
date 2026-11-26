// @vitest-environment jsdom
/**
 * Session B's round-3/4 handover (26 Nov):
 *  - H14: "Yes, cancel" tapped again after a cancel whose answer was lost is refused ("This booking is no longer
 *    active.") while the page still offered cancel, share and open-to-players. The page now refreshes on that
 *    refusal and shows the booking as it is. A dropped connection still reloads nothing (W5).
 *  - H9: a cancelled pay-at-desk booking still said "Pay at the club $20.00 … Settle with … when you arrive."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { replace: vi.fn(), refresh: vi.fn() };
let answers: { data: unknown; error: unknown }[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async () => answers.shift() ?? { data: null, error: null } }),
}));

// the booking page's server reads
let booking: Record<string, unknown> = {};
const ok = (data: unknown) => ({ data, error: null });
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async () => ok([]),
    from: (table: string) => {
      const answer = table === "bookings" ? ok(booking) : table === "sports" ? ok([{ code: "padel", name_en: "Padel" }]) : ok(null);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
      b.single = async () => answer; b.maybeSingle = async () => answer;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
      return b;
    },
  }),
}));

import CancelButton from "./CancelButton";
import BookingPage from "./page";

beforeEach(() => { answers = []; router.replace.mockReset(); router.refresh.mockReset(); });
afterEach(cleanup);

async function confirmCancel() {
  render(<CancelButton bookingId="b1" cutoffHours={6} cutoffLabel="Fri 28 Nov 12:00" clubInfoHref="/club/x/info" freeCancel nothingPaid />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));
}

describe("H14: cancel retried after a lost answer", () => {
  it("the refusal 'no longer active' refreshes the page, so it shows the booking as cancelled", async () => {
    answers = [{ data: null, error: { message: "Failed to fetch" } }, { data: null, error: { message: "not_confirmed", code: "P0001" } }];
    await confirmCancel();
    await screen.findByText(/Couldn't reach CourtBook/);
    expect(router.refresh).not.toHaveBeenCalled();   // a dropped connection reloads nothing (W5)
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText("This booking is no longer active.")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it("another refusal does not refresh", async () => {
    answers = [{ data: null, error: { message: "not_your_booking", code: "P0001" } }];
    await confirmCancel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Yes, cancel" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("H9: what a pay-at-desk booking says about paying", () => {
  const future = new Date(Date.now() + 3 * 86400_000);
  const make = (status: string) => ({
    id: "04692734-bb44-4d88-a171-fe1854f2c332", club_id: "c1", status, price_usd: 20, fee_usd: 0, cancelled_at: null,
    start_at: future.toISOString(), end_at: new Date(future.getTime() + 3600_000).toISOString(),
    clubs: { name: "Batroun Padel & Tennis Club", slug: "batroun", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: null, payment_mode: "at_desk", lat: null, lng: null },
    courts: { name: "Padel 2", sport: "padel" },
  });
  const page = async () => render(await BookingPage({ params: Promise.resolve({ id: "04692734-bb44-4d88-a171-fe1854f2c332" }), searchParams: Promise.resolve({}) }));

  it("confirmed: pay at the club, settle when you arrive (unchanged)", async () => {
    booking = make("confirmed");
    await page();
    expect(screen.getByText("Pay at the club")).toBeTruthy();
    expect(screen.getByText(/Settle with Batroun Padel & Tennis Club when you arrive/)).toBeTruthy();
  });
  it.each(["cancelled", "no_show"])("%s: no pay-at-club line, no 'settle when you arrive'", async (status) => {
    booking = make(status);
    await page();
    expect(screen.getByText(/^Status:/)).toBeTruthy();
    expect(screen.queryByText("Pay at the club")).toBeNull();
    expect(screen.queryByText(/Settle with/)).toBeNull();
    expect(screen.getByText("Nothing was paid through CourtBook.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });
});
